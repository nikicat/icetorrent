'use strict';

const bencode = require('bencode');
const {Store} = require('filestore');
const {fs} = require('io');
const {Listener} = require('listener');
const {Peer} = require('peer');
const traceback = require('traceback');
const timers = require('timers');
const http = require('http');
const settings = require('settings');
var {escape, Logged} = require('log');
const {Class} = require('heritage');
const {btoa} = require('base64');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const {Request} = require("request");
const {TrackerManager} = require('./tracker');
const {Swarm, generatePeerId} = require('./swarm');
const {computeHash} = require('./util');

function dumpObj(obj) {
    for (let key in Object.keys(obj)) {
        console.debug('this.peers['+key+']='+obj[key]);
    }
}

const fragmentSize = Math.pow(2, 14);

const TorrentManager = Class({
    implements: [Logged, EventTarget],
    name: 'TorrentManager',
    initialize: function() {
        this.torrents = Map();
        this.listener = new Listener();
        this.listener.on('newpeer', this.onPeer.bind(this));
        this.listener.start();
    },
    onPeer: function(conn) {
        let peer = new Peer(conn);
        peer.on('handshake', (function () {
            if (this.torrents.has(peer.infoHash)) {
                this.torrents.get(peer.infoHash).newPeer(peer);
            } else {
                peer.abort();
            }
        }).bind(this));
    },
    register: function(torrent) {
        this.torrents.set(torrent.infoHash, torrent);
        torrent.on('changed', (function() {
            emit(this, 'changed');
        }).bind(this));
        emit(this, 'changed');
    },
    load: function(metadata, options) {
        var metainfo = bencode.decode(metadata);
        if ('comment' in metainfo) {
            this.info('comment: "' + metainfo.comment + '"');
        }
        let torrent = new Torrent(metainfo.info, options);
        this.register(torrent);
        return torrent;
    },
    get webInfo() {
        return {
            torrents: [torrent.webInfo for each (torrent in this.torrents)],
            port: this.listener.port
        }
    }
});

exports.TorrentManager = TorrentManager;
exports.torrents = new TorrentManager();

const Torrent = Class({
    implements: [Logged, EventTarget],
    name: 'Torrent',
    initialize: function(info, options) {
        this.debug('info: '+JSON.stringify(info));
        this.metadata = info;
        this.infoHash = computeHash(info);
        this.peerId = options.peerId || generatePeerId();

        this.swarm = options.swarm || new Swarm({
            peerId: this.peerId,
            infoHash: this.infoHash
        });

        this.store = new Store(info);
        this.store.on('havepiece', this.swarm.havePiece.bind(this.swarm));
        // TODO: use event-based item requesting instead of polling
        //this.store.on('needpiece', this.onNeedPiece.bind(this));
        this.store.on('data', emit.bind(this, 'data'));
        this.store.on('end', emit.bind(this, 'end'));
        this.swarm.on('piecefragment', this.store.onPieceFragment.bind(this.store));
        this.swarm.on('request', (function (peer, index, offset, length) {
            if (this.store.havePiece(index)) {
                this.store.readPiecePart(index, offset, length, function (error, data) {
                    if (!error) {
                        peer.sendPiece(index, offset, data);
                    }
                });
            }
        }).bind(this));

        this.enabledFiles = [];

        this.trackers = options.trackers || new TrackerManager({
            port: this.listener.port,
            peerId: this.peerId,
            infoHash: this.infoHash,
            announce: options.announce,
            announceList: options['announce-list']
        });
        this.trackers.on('peeraddress', this.swarm.addPeerAddress.bind(this.swarm));

        this._state = 'initialized';
        this.debug('initialized');
    },
    get tag() {
        return this.infoHash ? btoa(this.infoHash.slice(0, 5)).slice(0, -1) : 'unset';
    },
    get webInfo() {
        return {
            dest: this.store.destDir,
            peers: this.peerPool.webInfo,
            name: this.metadata.name,
            state: this.state
        };
    },
    get state() {
        return this._state;
    },
    set state(_state) {
        this._state = _state;
        emit(this, 'changed:state');
    },


    addPeerExtension: function(peer, extension) {
        if (extension === 'ut_metadata') {
            this.metadataPeers.push(peer);
        }
    },

    checkFiles: function(callback) {
        this.info('inspecting files');
        this.store.inspect((function (error){
            if (error) {
                this.error('could not inspect torrent files ' + error);
                console.exception(error);
                callback(error);
            } else {
                this.info('finished inspecting files.');
                callback(null);
            }
        }).bind(this));
    },
    
    enableFile: function(name) {
        this.enabledFiles.push(name);
    },

    start: function(options) {
        this._state = 'started';
        this.debug('started');
        this.store.inspect();
        this.trackers.start();
        this.mainLoop = timers.setInterval((function() {
            try {
                let pieces = this.getPiecesToRequest(options.progressive===false);
                this.requestPieces(pieces);
            } catch (e) {
                console.exception(e);
            }
        }).bind(this), 5000);
    },

    stop: function() {
        timers.clearInterval(this.mainLoop);
    },

    getPiecesToRequest: function(sortByAvailability) {
        this.debug('getPiecesToRequest sortByAvailability='+sortByAvailability);
 
        let piecesToRequest = [];
        let available = this.swarm.available;
        for each (let name in this.enabledFiles) {
            this.debug('checking pieces for file '+name);
            let file = this.store.getFile(name);
            for each (let i in file.getNeededPieces()) {
                this.debug('piece '+i+' is needed for file '+file.name);
                if (i in available) {
                    piecesToRequest.push(i);
                } else {
                    this.debug('but unavailable');
                }
            }
 
            if (sortByAvailability) {
                piecesToRequest.sort(function(a, b) {
                    return available[a] - available[b]; //sort the pieces that I don't have by the number of people who have it
                });
                this.debug('pieces sorted by availability (rarest first). ('+piecesToRequest.length+') :'+piecesToRequest.join(', '));
            }
        }
        
       return piecesToRequest;
    },

    requestPieces: function(pieces) {
        for each (let piece in pieces.slice(0, 50)) {
            let piecelength = (piece == this.store.pieceCount - 1) ? this.store.lastPieceLength : this.store.pieceLength;

            for (let start = 0; start < piecelength; start += fragmentSize) {
                this.swarm.requestPieceFragment(piece, start, ((start + fragmentSize) <= piecelength ? fragmentSize : (piecelength - start)));
            }
        }
    }
});

exports.Torrent = Torrent;

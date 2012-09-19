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
    load: function(uri, callback) {
        Request({
            url: uri.spec,
            onComplete: function(response) {
                this.debug('metainfo: '+escape(response));
                var metainfo = bencode.decode(response);
                if ('comment' in metainfo) {
                    this.info('comment: "' + metainfo.comment + '"');
                }
                let torrent = new Torrent(metainfo.info);
                this.register(torrent);
                callback(null, torrent);
            },
            onError: function(e) {
                this.error('error while loading torrent from '+uri.spec+': '+e);
                callback(e);
            }
        }).get();
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
    initialize: function(metadata) {
        this.metadata = metadata;
        this.infoHash = computeHash(metadata);
        this.peerId = generatePeerId();

        this.swarm = new Swarm({
            peerId: this.peerId,
            infoHash: this.infoHash
        });
        this.swarm.on('piecefragment', this.onPieceFragment.bind(this));

        this.store = new Store(metadata, settings.destDir);
        this.store.on('havepiece', this.swarm.havePiece.bind(this.swarm));
        this.store.on('needpiece', this.onNeedPiece.bind(this));
        this.store.on('data', emit.bind(this, 'data'));
        this.store.on('end', emit.bind(this, 'end'));

        this.downloading = {};
        this.piecesQueue = {};

        this.trackers = new TrackerManager({
            port: this.listener.port,
            peerId: this.peerId,
            infoHash: this.infoHash,
            announce: metaInfo.announce,
            announceList: metaInfo['announce-list']
        });
        this.trackers.on('peeraddress', this.addPeerAddress.bind(this));

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

    havePiece: function(index) {
        delete this.piecesQueue[index]; // Delete from the pieces Queue
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

    start: function(options) {
        this._state = 'started';
        this.debug('started');
        this.notifyAboutPieces();
        this.store.inspect();
        this.listener.start();
        this.trackers.start();
        this.mainLoop = timers.setInterval((function() {
            var pieces = this.getPiecesToRequest(options.progressive===false);
            this.requestPieces(pieces);
            this.replyToRequests();
        }).bind(this), 5000);
    },

    stop: function() {
        timers.clearInterval(this.mainLoop);
    },

    getPiecesToRequest: function(sortByAvailability) {
        this.trace('getPiecesToRequest sortByAvailability='+sortByAvailability);
 
        let piecesToRequest = [];
        for each (i in this.store.needed) {
            if (this.swarm.available.has(i)) {
                piecesToRequest.push(i); //if I don't have it, and somebody else haz it, then add the index to pieces array
            }
        }
        
        
        if (sortByAvailability) {
            piecesToRequest.sort(function(a, b) {
                return availablePieces[a] - availablePieces[b]; //sort the pieces that I don't have by the number of people who have it
            });
            this.debug('pieces sorted by availability (rarest first). ('+piecesToRequest.length+') :'+piecesToRequest.join(', '));
        }
        
       return piecesToRequest;
    },

    requestPieces: function(pieces) {
        for each (piece in pieces.slice(0, 5)) {
            let piecelength = (piece == this.store.pieceCount - 1) ? this.store.lastPieceLength : this.store.pieceLength;

            for (var start = 0; start < piecelength; start += fragmentSize) {
                this.swarm.requestPieceFragment(piece, start, ((start + fragmentSize) <= piecelength ? fragmentSize : (piecelength - start)));
            }
        }
    }
});

exports.Torrent = Torrent;

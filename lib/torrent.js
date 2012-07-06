'use strict';

const bencode = require('bencode');
const cryptolib = require('crypto');
const {Store} = require('filestore');
const fs = require('fs');
const listener = require('listener');
const {Peer} = require('peer');
const {createTrackers} = require("tracker");
const traceback = require('traceback');
const timers = require('timers');
const http = require('http');
const settings = require('settings');
var {escape, Logged} = require('log');
const querystring = require('querystring');
const log4js = require('log4javascript');
const { Class } = require('heritage');
const { btoa } = require('base64');

function dumpObj(obj) {
    for (let key in Object.keys(obj)) {
        console.debug('this.peers['+key+']='+obj[key]);
    }
}

function choice(arr, count=1) {
    let source = [arr[key] for (key in Object.keys(arr))];
    let results = [];
    for (var i=0; i<count && source.length > 0; ++i) {
        let index = Math.floor(source.length * Math.random());
        let elem = source[index];
        source.splice(index, 1);
        results.push(elem);
    }
    return count === 1 ? results[0] : results;
}
 
function decodeHost(address) {
    if (address.length == 18) {
        // ipv6
        var host = [(address.charCodeAt(i)&0xff).toString(16) for (i in address.slice(0, -2))].join(':');
        host = (host+':').replace(/([A-Fa-f0-9]{1,2}):([A-Fa-f0-9]{1,2}):/ig, "$1$2:").slice(0, -1);
        return host;
    } else if (address.length == 6) {
        // ipv4
        return [address.charCodeAt(i)&0xff for (i in address.slice(0, -2))].join('.');
    } else {
        throw new Error('wrong peer address length ' + address.length);
    }
}
   
function decodePort(address) {
    var port = address.slice(-2);
    return ((port.charCodeAt(0)&0xff) << 8) + (port.charCodeAt(1)&0xff);
}

const fragmentSize = Math.pow(2, 15);

const Torrent = Class({
    implements: [Logged],
    initialize: function() {
        this.destDir = settings.destDir;
        this.listenerPort = 6881+Math.floor(10*Math.random());
        this.peerId = ('-JS0001-' + Math.random().toString(36).substr(3) + Math.random().toString(36).substr(3)).substr(0, 20);
        this.peers = {};
        this.metadataPeers = [];
        this.store = null;
        this.downloading = {};
        this.piecesQueue = {};
        this.magnetLoaded = null;
    },
    get tag() {
        return this.infoHash ? btoa(this.infoHash.slice(0, 5)).slice(0, -1) : 'unset';
    },
    pingTracker: function(trackerClient){
        var params = {
            info_hash: this.infoHash,
            peer_id: this.peerId,
            port: this.listenerPort,
            uploaded: 0,
            downloaded: 0,
            numwant: 50,
            left: this.store ? this.store.left : 0,
            compact: 1,
            event: 'started'
        };
        trackerClient.ping(params, (function(error, response) {
            if (!error) {
                var interval = response.interval;
                if ('peers' in response) {
                    var newPeers = response.peers;
                    var numPeers = newPeers.length / 6;
                    this.info('tracker gave us ' + numPeers + ' ipv4 peers.');
                    for (var i = 0; i < numPeers; i++) {
                        this.addPeer(newPeers.substring(i * 6, (i + 1) * 6));
                    }
                }
                if ('peers6' in response) {
                    var newPeers = response.peers6;
                    var numPeers = newPeers.length / 18;
                    this.info('tracker gave us ' + numPeers + ' ipv6 peers.');
                    for (var i = 0; i < numPeers; i++) {
                        this.addPeer(newPeers.substring(i * 18, (i + 1) * 18));
                    }
                }
            } else {
                this.error('tracker returned error: '+error);
                console.exception(error);
                var interval = 20*60;
            }
            this.pingTimer = timers.setTimeout(this.pingTracker.bind(this, trackerClient), interval * 1000);
        }).bind(this));
    },
    
    addPeer: function(peerAddress){
        if (!(peerAddress in this.peers)) {
            try {
                let peer = Peer(peerAddress, decodeHost(peerAddress), decodePort(peerAddress), this);
                this.peers[peerAddress] = peer;
            } catch (e) {
                this.error('exception while creating peer ' + e);
                console.exception(e);
            }
        }
    },
    
    removePeer: function(peerAddress){
        var peer = this.peers[peerAddress];
        if (peer) {
            peer.info('removing');
            delete this.peers[peerAddress];
        }
    },

    addPeerExtension: function(peer, extension) {
        if (extension === 'ut_metadata') {
            this.metadataPeers.push(peer);
        }
    },
    
    loadFromMagnet: function(uri, callback) {
        this.debug('magnet link: query='+uri.query);
        var args = querystring.parse(uri.query);
        if (args.xt.substr(0, 9) !== 'urn:btih:') {
            callback(new Error('broken magnet: link: '+uri.spec));
        }
        this.infoHash = args.xt.substr(9).replace(/([0-9A-Fa-f]{2})/g, function() String.fromCharCode(parseInt(arguments[1], 16)));
        this.debug('magnet link info hash: '+this.infoHash);
        if (!args.tr) {
            this.error('magnet links without trackers are not supported (no DHT support)');
            callback(new Error('magnet links without trackers are not supported (no DHT support)'));
        } else {
            this.assert(typeof callback === 'function', 'assert');
            this.magnetLoaded = callback;
            this.assert(this.magnetLoaded === callback, 'assert');
            let trackers = createTrackers(args.tr[0], [args.tr.slice(1)]);
            this.debug(trackers);
            for (let client of trackers) {
                this.pingTracker(client);
            }
        }
    },

    setMetadataSize: function(size) {
        if (this.metadataSize) {
            if (this.metadataSize !== size) {
                this.error('metadata size already set to '+this.metadataSize+', new size '+size);
            }
        } else {
            this.debug('setting metadata size to '+size);
            this.metadataSize = size;
            this.metadataPieces = Array(Math.ceil(size/16384));
            timers.setInterval(this.requestMetadata.bind(this), 30000);
            this.requestMetadata();
        }
    },

    requestMetadata: function() {
        if (this.metadataPeers.length > 0) {
            for (var i=0; i<this.metadataPieces.length; ++i) {
                if (this.metadataPieces[i] === undefined) {
                    // send piece request to 2 random peers
                    let randomPeers = choice(this.metadataPeers, 2);
                    this.debug('requesting metadata from '+randomPeers);
                    randomPeers.forEach(function (peer) { peer.sendMetadataRequest(i); });
                }
            }
        } else {
            this.info('no peers supporting metadata exchange, could not request metadata');
        }
    },

    addMetadataPiece: function(piece, data) {
        if (piece >= this.metadataPieces.length || piece < 0) {
            throw new Error('piece '+piece+' out of range '+this.metadataPieces.length);
        } else if (piece === this.metadataPieces.length - 1) {
            if (data.length % 16384 !== this.metadataSize % 16384) {
                throw new Error('invalid last piece length '+data.length+', correct is '+this.metadataSize % 16384);
            }
        } else {
            if (data.length !== 16384) {
                throw new Error('invalid length for non-last piece '+piece+': '+data.length);
            }
        }
        var pieceData = this.metadataPieces[piece];
        if (pieceData !== undefined && pieceData !== data) {
            throw new Error('could override metadata piece '+piece+' with different data');
        } else {
            this.metadataPieces[piece] = data;
            if (this.metadataPieces.every(function (data) data !== undefined)) {
                let metadata = bencode.decode(this.metadataPieces.join());
                let infoHash = this.computeHash(metadata);
                let error = null;
                if (infoHash != this.infoHash) {
                    throw new Error('metadata hash mismatch: expected '+this.infoHash+', actual '+infoHash);
                }
                this.metadata = metadata;
                this.store = Store(metadata, this.destDir);
                for (let peer in this.peers) {
                    this.peers[peer].setPieceCount(this.store.pieceCount);
                }
                let callback = this.magnetLoaded;
                this.magnetLoaded = null;
                callback(error);
            }
        }
    },

    addPieceFragment: function(index, offset, data) {
        var length = data.length;
        var pieceLength = (index === this.store.pieceCount - 1) ? this.store.lastPieceLength : this.store.pieceLength;
        var pieceCount = this.store.pieceCount;
        if (!((offset >= 0 && offset + length <= pieceLength) &&
            (length > 0 && length <= 32 * 1024) &&
            (index >= 0 && index < pieceCount))) {
            this.error('could not add corrupted piece: index='+index+' offset='+offset+' length='+length);
            throw new Error('bad piece parameters');
        }
        this.debug("received piece " + index +' ' + offset + ' ' + length); // Reduced verbosity
        
        if(!this.downloading[index])
            this.downloading[index] = {};
        this.downloading[index][offset] = true;

        /*if (this.pieces[index] === undefined) {
            this.pieces[index] = new Uint8Array(pieceLength);
        }

        let piece = this.pieces[index];
        piece.set(data, offset);

        return;*/

        this.store.writePiecePart(index, begin, block, (function(index, err) {
            if (err) {
                this.warning('piece '+index+' writing failed: '+err);
                console.exception(err);
                return;
            }
            this.debug('wrote piece ' + index); // Reduced verbosity.
            
            var hasdone = 0;                
            for (var z in this.downloading[index])
                hasdone += +this.downloading[index][z];
            
            if (hasdone === Math.ceil(pieceLength/fragmentSize)){
                delete this.downloading[index];
                
                this.store.inspectPiece(index, (function(error) {
                    if (!error) {
                        this.info('wrote piece #' + index);
                        this.store.goodPieces.set(index, 1); //change bitfield
                        delete this.piecesQueue[index]; // Delete from the pieces Queue
                        let availableFromStart = this._availableFromStart();

                        if (this.progressive && this.notifiedPieces < availableFromStart) {
                            this.notifyAboutPieces(availableFromStart);
                        }
                        for (var i in this.peers) {
                            this.peers[i].have(index);
                        }
                    } else {
                        this.debug('waah broken piece: '+error);
                        console.exception(error);
                    }
                }).bind(this))
            } else {
                this.debug('not done yet')
            }
        }).bind(this));
    },

    notifyAboutPieces: function(lastAvailable) {
        if (this.notifiedPieces < lastAvailable) {
            this.store.readPiece(this.notifiedPieces, (function (error, data) {
                if (error) {
                    this.error('failed to read piece '+this.notifiedPieces);
                } else {
                    if (data) {
                        this.dataCallback(data);
                    } else {
                        this.notifiedPieces++;
                        this.notifyAboutPieces(lastAvailable);
                    }
                }
            }).bind(this));
        } else if (this.notifiedPieces === this.store.pieceCount) {
            this.dataCallback(null);
        }
    },

    _availableFromStart: function() {
        let available = this.store.goodPieces.getBitArray.indexOf(0);
        return available == -1 ? this.store.pieceCount : available;
    },

    computeHash: function(info) {
        let encoded = bencode.encode(info);
        this.debug('encoded info: '+escape(encoded));
        let hash = new cryptolib.Hash('sha1');
        hash.update(encoded);
        return hash.digest('binary');
    },
        
    initTrackers: function(announce, announceList) {
        listener.create(this.listenerPort, this);
        this.trackerClients = createTrackers(announce, announceList);
        for (let client of this.trackerClients) {
            this.pingTracker(client);
        }
    },

    loadFromFile: function(torrentPath, callback) {
        fs.readFile(torrentPath, 'binary', (function(error, contents) {
            if (error) {
                this.error('could not open torrent file ' + torrentPath + ': ' + error);
                console.exception(error);
                callback(error);
            } else {
                try {
                    this.debug('metainfo: '+escape(contents));
                    var metaInfo = bencode.decode(contents);
                    if ('comment' in metaInfo) {
                        this.info('comment: "' + metaInfo.comment + '"');
                    }
                    this.metadata = metaInfo.info;
                    this.metadataSize = this.metadata.length;
                    this.infoHash = this.computeHash(this.metadata);
                    this.store = Store(this.metadata, this.destDir);
                    this.initTrackers(metaInfo.announce, metaInfo['announce-list']);
                    callback(null);
                } catch (e) {
                    callback(e);
                }
            }
        }).bind(this));
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

    start: function(dataCallback=function() {}, progressive=false) {
        this.dataCallback = dataCallback;
        this.porgressive = progressive;
        this.notifiedPieces = 0;
        this.mainLoop = timers.setInterval((function() {
            var pieces = this.getPiecesToRequest(progressive===false);
            this.requestPieces(pieces);
            this.replyToRequests();
        }).bind(this), 5000);
        this.keepaliveLoop = timers.setInterval(this.sendKeepalives.bind(this), 30000);
    },

    stop: function() {
        timers.clearInterval(this.mainLoop);
        timers.clearInterval(this.keepaliveLoop);
    },

    sendKeepalives: function() {
        this.info('send keepalives');
        for (var i in this.peers) {
            this.peers[i].sendKeepalive();
        }
    },

    getPiecesToRequest: function(sortByAvailability=true) {
        //hey why not do a totally unoptimized super duper crappy whatnot
        var availablePieces = { //piece_index: number_of_peers_have_it
        };
        
        /* Find all the pieces that the peers have */
        for (var i in this.peers) { //iterate through peers,
            this.peers[i].getBitfield().getBitArray().forEach(function(val, index){ //loop through their bitfield
                availablePieces[index] = (availablePieces[index] || 0) + (+val); //add it to a map of pieces (since zero = dont have, 1 = have, adding works)
            });
        }
        
        // Delete any pieces that are in request queue
        // & Purge pieces queue of any pieces > 120 seconds after requested not recieved.
        for (let i in this.piecesQueue) {
            if (this.piecesQueue[i] < (new Date().getTime() - 15 * 1000)) {
            
                delete this.piecesQueue[i];
                
                for (let j in this.peers) {
                
                    var piecelength = (i == this.store.pieceCount - 1) ? this.store.lastPieceLength : this.store.pieceLength;
                    
                    for (var start = 0; start < piecelength; start += Math.pow(2, 15)) {
                        this.peers[j].sendCancel(i, start, ((start + Math.pow(2, 15)) <= piecelength ? Math.pow(2, 15) : (piecelength - start)));
                    }
                }
                
                this.info('piece #' + i + ' timed out');
                
            }
            delete availablePieces[i];
        };
        
        
        var piecesToRequest = [];
        this.store.goodPieces.getBitArray().forEach(function(v, i){ //loop through my bitfield
            if (v == 0 && availablePieces[i]) {
                piecesToRequest.push(i); //if I don't have it, and somebody else haz it, then add the index to pieces array
            } else if (v == 1) {
                delete this.piecesQueue[i];
            }
        }, this);
        
        
        if (sortByAvailability) {
            piecesToRequest.sort(function(a, b) {
                return availablePieces[a] - availablePieces[b]; //sort the pieces that I don't have by the number of people who have it
            });
            this.debug('pieces sorted by availability (rarest first). ('+piecesToRequest.length+') :'+piecesToRequest.join(', '));
        }
        
        //pieces array now contains a list of pieces where 0 = rarest (and if there's only one peer, then it's sorted numerically)
        //console.info('Pieces sorted by availability (rarest first). '+pieces_array.join(', '));
       return piecesToRequest;
    },
        
    requestPieces: function(pieces) {
        var peers_random = [];
        for (let i in this.peers) {
            peers_random.push(this.peers[i]);
        }

        peers_random.forEach(function(peer) {
            peer.debug('choked='+peer.peerChoked+' interested='+peer.peerInterested);
        });
        
        pieces.slice(0, 5).forEach(function(piece){
            peers_random.sort(function(){
                return Math.random() - .5; //TODO: replace with fisher yates knuth
            });
            for (let peer of peers_random) { // Crude non-even shuffling algorithm
                try {
                    if (peer.getBitfield().getBitArray()[piece] /*&& !peers_random[i].peerChoked*/ && !this.piecesQueue[piece]) {
                    
                        peer.interested = true;
                        peer.choked =false;
                        
                        let piecelength = (piece == this.store.pieceCount - 1) ? this.store.lastPieceLength : this.store.pieceLength;
                        
                        for (var start = 0; start < piecelength; start += fragmentSize) {
                            peer.sendRequest(piece, start, ((start + fragmentSize) <= piecelength ? fragmentSize : (piecelength - start)));
                        }
                        
                        // Add piece to the list of pieces that are being queued.
                        this.piecesQueue[piece] = new Date().getTime();
                        
                        peer.info('requested for part ' + piece);
                        break;
                    }
                } catch (e) {
                    peer.error('failed to request piece '+piece);
                    console.exception(e);
                }
            }
        }, this);
        
        var gotParts = this.store.goodPieces.getBitArray().filter(function(val){
            return val == '1';
        }).length;
        var totalParts = this.store.pieceCount
        
        this.info(gotParts + "/" + totalParts + " recieved (" + (Math.floor((gotParts / totalParts) * 100 * 100) / 100) + "%)");
        
    },

    replyToRequests: function() {
        var request;
        
        for (let i in this.peers) {
            var peer = this.peers[i];
            for (let request in peer.requests) {
                if (this.store.goodPieces.getBitArray()[request.index] == '1') {
                    this.store.readPiecePart(request.index, request.begin, request.length, function(err, data){
                        if (err) {
                            this.error('error reading piece part to send to peer');
                        } else {
                            peer.sendPiece(request.index, request.begin, data);
                            this.info('successfully sent piece ' + request.index + ' to ' + peer.host);
                        }
                    });
                } else {
                    this.info('peer requested for part ' + request.index + ', but I do not have it.');
                }
            }
            peer.requests = [];
        }
        
        this.info('number of peers: ' + Object.keys(this.peers).length);
    }, 
    
});

exports.Torrent = Torrent;

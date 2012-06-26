var bencode = require('bencode');
var cryptolib = require('crypto');
var filestore = require('filestore');
var fs = require('fs');
var listener = require('listener');
var peer = require('peer');
var tracker = require("tracker");
var traceback = require('traceback');
var timers = require('timers');
var http = require('http');
const settings = require('settings');
var {escape, Logged} = require('log');

function choice(array, count=1) {
    var results = [];
    for (var i=0; i<count; ++i) {
        results.push(array[Math.floor(array.length * Math.random())]);
    }
    return count === 1 ? results[0] : results;
}

const Torrent = Logged.compose({
    tag: 'Torrent<>',
    constructor: function() {
        this.destDir = settings.destDir;
        this.listenerPort = 6881+Math.floor(10*Math.random());
        this.peerId = ('-JS0001-' + Math.random().toString(36).substr(3) + Math.random().toString(36).substr(3)).substr(0, 20);
        this.peers = {};
        this.store = {};
        this.downloading = {};
        this.piecesQueue = {};
    },
    pingTracker: function(trackerClient){
        var params = {
            info_hash: this.infoHash,
            peer_id: this.peerId,
            port: this.listenerPort,
            uploaded: 0,
            downloaded: 0,
            numwant: 50,
            left: this.store.left,
            compact: 1,
            event: 'started'
        };
        trackerClient.ping(params, (function(error, response) {
            if (!error) {
                var interval = response.interval;
                if ('peers' in response) {
                    var newPeers = response.peers;
                    var numPeers = newPeers.length / 6;
                    console.log('tracker gave us ' + numPeers + ' ipv4 peers.');
                    for (var i = 0; i < numPeers; i++) {
                        this.addPeer(newPeers.substring(i * 6, (i + 1) * 6));
                    }
                }
                if ('peers6' in response) {
                    var newPeers = response.peers6;
                    var numPeers = newPeers.length / 18;
                    console.log('tracker gave us ' + numPeers + ' ipv6 peers.');
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
                this.peers[peerAddress] = peer.Peer(peerAddress, this.decodeHost(peerAddress), this.decodePort(peerAddress), this);
            }
            catch (e) {
                this.error('exception while creating peer ' + e);
                console.exception(e);
            }
        }
    },
    
    removePeer: function(peerAddress){
        var peer = this.peers[peerAddress];
        if (peer) {
            peer.log('removing');
            delete this.peers[peerAddress];
        }
    },
    
    loadFromMagnet: function(uri, callback) {
        var args = querystring.parse(uri.query);
        if (args.xt.substr(0, 9) !== 'urn:btih:') {
            callback(new Error('broken magnet: link: '+uri.spec));
        }
        this.infoHash = args.xt.substr(9);
        if (!args.tr) {
            this.error('magnet links without trackers are not supported (no DHT support)');
            callback(new Error('magnet links without trackers are not supported (no DHT support)'));
        }
        this.magnetLoaded = callback;
        for (trackerUrl in args.tr) {
            var trackerClient = tracker.create(trackerUrl);
            this.pingTracker(trackerClient);
        }
        timers.setInterval(this.requestMetadata.bind(this), 30000);
    },

    setMetadataSize: function(size) {
        if (this.metadataSize) {
            if (this.metadataSize !== size) {
                this.error('metadata size already set to '+this.metadataSize+', new size '+size);
            }
        } else {
            this.debug('setting metadata size to '+size);
            this.metadataPieces = Array(Math.ceil(size/16384));
        }
    },

    requestMetadata: function() {
        for (var i=0; i<this.metadataPieces.length; ++i) {
            if (this.metadataPieces[i] === undefined) {
                // send piece request to 2 random peers
                choice(this.peers, 2).forEach(function (peer) peer.sendMetadataRequest(i));
            }
        }
    },

    addMetadataPiece: function(piece, data) {
        if (piece >= this.metadataPieces.length || piece < 0) {
            throw new Error('piece '+piece+' out of range '+this.metadataPieces.length);
        } else if (piece === this.metadataPieces.length - 1) {
            if (data.length % 16384 !== this.metadataLength % 16384) {
                throw new Error('invalid last piece length '+data.length);
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
                var info = this.metadataPieces.join();
                var infoHash = this.computeHash(info);
                var error = null;
                if (infoHash != this.infoHash) {
                    error = new Error('metadata hash mismatch: expected '+this.infoHash+', actual '+infoHash);
                }
                var callback = this.magnetLoaded;
                this.magnetLoaded = null;
                callback(error);
            }
        }
    },
    
    computeHash: function(info){
        var encoded = bencode.encode(info);
        this.debug('encoded info: '+escape(encoded));
        hash = new cryptolib.Hash('sha1');
        hash.update(encoded);
        return hash.digest('binary');
    },
    
    decodeHost: function(address){
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
    },
    
    decodePort: function(address){
        var port = address.slice(-2);
        return ((port.charCodeAt(0)&0xff) << 8) + (port.charCodeAt(1)&0xff);
    },
    
    initTrackers: function(announce, announceList) {
        listener.create(this.listenerPort, this);
        this.trackerClients = tracker.create(announce, announceList);
        for (i in this.trackerClients) {
            this.pingTracker(this.trackerClients[i]);
        }
    },

    loadFromFile: function(torrentPath, callback) {
        fs.readFile(torrentPath, 'binary', (function(error, contents) {
            if (error) {
                this.error('could not open torrent file ' + torrentPath + ': ' + error);
                console.exception(error);
                callback(error);
            } else {
                this.debug('metainfo: '+escape(contents));
                var metaInfo = bencode.decode(contents);
                if ('comment' in metaInfo) {
                    this.log('comment: "' + metaInfo.comment + '"');
                }
                this.info = metaInfo.info;
                this.metadataSize = this.info.length;
                this.infoHash = this.computeHash(this.info);
                this.initTrackers(metaInfo.announce, metaInfo['announce-list']);
                callback(null);
            }
        }).bind(this));
    },

    checkFiles: function(callback) {
        this.store = new filestore.Store(this.info, this.destDir);
        this.log('inspecting files');
        this.store.inspect((function (error){
            if (error) {
                this.error('could not inspect torrent files ' + error);
                console.exception(error);
                callback(error);
            } else {
                this.log('finished inspecting files.');
                callback(null);
            }
        }).bind(this));
    },

    start: function() {
        this.mainLoop = timers.setInterval((function() {
            var pieces = this.getPiecesToRequest();
            this.debug('pieces sorted by availability (rarest first). ('+pieces.length+') :'+pieces.join(', '));
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
        this.log('send keepalives');
        for (var i in this.peers) {
            this.peers[i].sendKeepalive();
        }
    },

    getPiecesToRequest: function() {
        //hey why not do a totally unoptimized super duper crappy whatnot
        var pieces = { //piece_index: number_of_peers_have_it
        };
        
        /* Find all the pieces that the peers have */
        for (var i in this.peers) { //iterate through peers,
            this.peers[i].getBitfield().getBitArray().forEach(function(val, index){ //loop through their bitfield
                pieces[index] = (pieces[index] || 0) + (+val); //add it to a map of pieces (since zero = dont have, 1 = have, adding works)
            });
        }
        
        // Delete any pieces that are in request queue
        // & Purge pieces queue of any pieces > 120 seconds after requested not recieved.
        for (i in this.piecesQueue) {
            if (this.piecesQueue[i] < (new Date().getTime() - 15 * 1000)) {
            
                delete this.piecesQueue[i];
                
                for (j in this.peers) {
                
                    var piecelength = (i == this.store.pieceCount - 1) ? this.store.lastPieceLength : this.store.pieceLength;
                    
                    for (var start = 0; start < piecelength; start += Math.pow(2, 15)) {
                        this.peers[j].sendCancel(i, start, ((start + Math.pow(2, 15)) <= piecelength ? Math.pow(2, 15) : (piecelength - start)));
                    }
                }
                
                this.log('piece #' + i + ' timed out');
                
            }
            delete pieces[i];
        };
        
        
        var pieces_array = [];
        this.store.goodPieces.getBitArray().forEach(function(v, i){ //loop through my bitfield
            if (v == 0 && pieces[i]) {
                //console.debug('piece index: '+i+' == i no haz');
                pieces_array.push(i); //if I don't have it, and somebody else haz it, then add the index to pieces array
            } else if (v == 1) {
                delete this.piecesQueue[i];
                //console.debug('piece index: '+i+' == i haz');
            }
        }, this);
        
        
        pieces_array.sort(function(a, b){
            return pieces[a] - pieces[b]; //sort the pieces that I don't have by the number of people who have it
        });
        
        //pieces array now contains a list of pieces where 0 = rarest (and if there's only one peer, then it's sorted numerically)
        //console.log('Pieces sorted by availability (rarest first). '+pieces_array.join(', '));
        
        /*
if(Object.size(that.piecesQueue) > 100) { // Only have 50 pieces requested at the same time?
sys.log('Limiting queue to 100 requests');
return;
}
*/
        return pieces_array;
    },
        
    requestPieces: function(pieces_array) {
        var peers_random = [];
        for (i in this.peers) {
            peers_random.push(this.peers[i]);
        }
        peers_random.sort(function(){
            return Math.random() - .5; //TODO: replace with fisher yates knuth
        });

        peers_random.forEach(function(peer) {
            peer.debug('choked='+peer.peerChoked+' interested='+peer.peerInterested);
        });
        
        //[pieces_array[0]].forEach(function(val, index) {
        pieces_array.slice(0, 5).forEach(function(val, index){
            for (i = 0; i < peers_random.length; i++) { // Crude non-even shuffling algorithm
                if (peers_random[i].getBitfield().getBitArray()[val] /*&& !peers_random[i].peerChoked*/ && !this.piecesQueue[val]) {
                
                    peers_random[i].interested = true;
                    peers_random[i].choked =false;
                    
                    var piecelength = (val == this.store.pieceCount - 1) ? this.store.lastPieceLength : this.store.pieceLength;
                    
                    for (var start = 0; start < piecelength; start += Math.pow(2, 15)) {
                        peers_random[i].sendRequest(val, start, ((start + Math.pow(2, 15)) <= piecelength ? Math.pow(2, 15) : (piecelength - start)));
                        // Too verbose
                        //sys.log('requesting ('+[val, start, ((start+Math.pow(2,15)) <= piecelength ? Math.pow(2,15) : (piecelength-start))].join(', ')+')');
                    }
                    
                    // Add piece to the list of pieces that are being queued.
                    this.piecesQueue[val] = new Date().getTime();
                    
                    peers_random[i].log('requested for part ' + val);
                    break;
                }
            }
        }, this);
        
        var gotParts = this.store.goodPieces.getBitArray().filter(function(val){
            return val == '1';
        }).length;
        var totalParts = this.store.pieceCount
        
        console.log(gotParts + "/" + totalParts + " recieved (" + (Math.floor((gotParts / totalParts) * 100 * 100) / 100) + "%)");
        
    },

    replyToRequests: function() {
        var request;
        
        for (i in this.peers) {
            var peer = this.peers[i];
            for (request in peer.requests) {
                if (this.store.goodPieces.getBitArray()[request.index] == '1') {
                    this.store.readPiecePart(request.index, request.begin, request.length, function(err, data){
                        if (err) {
                            this.error('error reading piece part to send to peer');
                        } else {
                            peer.sendPiece(request.index, request.begin, data);
                            this.log('successfully sent piece ' + request.index + ' to ' + peer.host);
                        }
                    });
                } else {
                    this.log('peer requested for part ' + request.index + ', but I do not have it.');
                }
            }
            peer.requests = [];
        }
        
        this.log('# of peers: ' + Object.keys(this.peers).length);
    }, 
    
});

exports.Torrent = Torrent;

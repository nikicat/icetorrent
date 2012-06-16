var bencode = require('bencode');
var cryptolib = require('crypto');
var filestore = require('filestore');
var fs = require('fs');
var listener = require('listener');
var peer = require('peer');
var tracker = require("tracker");
var traceback = require('traceback');
var timer = require('timer');
var http = require('http');
var {escape} = require('log');

function Torrent(torrentPath, destDir) {
    this.torrentPath = torrentPath;
    this.destDir=  destDir;
    this.listenerPort = 6881+Math.floor(10*Math.random());
    this.peerId = ('-JS0001-' + Math.random().toString(36).substr(3) + Math.random().toString(36).substr(3)).substr(0, 20);
    this.peers = {};
    this.store = {};
    this.downloading = {};
    this.metaInfo = {};
    this.piecesQueue = {};
}

Torrent.prototype = {
    pingTracker: function(trackerClient){
        var params = {
            info_hash: this.metaInfo.info_hash,
            peer_id: this.peerId,
            port: this.listenerPort,
            uploaded: 0,
            downloaded: 0,
            numwant: 50,
            left: this.store.left,
            compact: 1,
            event: 'started'
        };
        tracker.ping(trackerClient, params, (function(error, response){
            var interval = 3600;
            if (!error) {
                interval = Math.max(interval, response.interval);
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
            }
            else {
                if (error instanceof http.HttpError) {
                    console.error('tracker '+trackerClient.metaInfo.announce+' returned http code '+error.statusCode);
                } else {
                    console.error('tracker '+trackerClient.metaInfo.announce+': '+error);
                    console.exception(error);
                }
            }
            this.pingTimer = timer.setTimeout(this.pingTracker.bind(this, trackerClient), interval * 1000);
        }).bind(this));
    },
    
    addPeer: function(peerAddress){
        if (!(peerAddress in this.peers)) {
            try {
                this.peers[peerAddress] = new peer.Peer(peerAddress, this.decodeHost(peerAddress), this.decodePort(peerAddress), this);
            }
            catch (e) {
                console.error('exception while creating peer ' + e);
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
    
    computeHash: function(info){
        var encoded = bencode.encode(info);
        console.debug('encoded info: '+escape(encoded));
        hash = new cryptolib.Hash('sha1');
        hash.update(encoded);
        return hash.digest('binary');
    },
    
    decodeHost: function(address){
        if (address.length == 18) {
            var host = [(address.charCodeAt(i)&0xff).toString(16) for (i in address.slice(0, -2))].join(':');
            return (host+':').replace(/([A-Fa-f0-9]{1,2}):([A-Fa-f0-9]{1,2}):/ig, "$1$2:").slice(0, -1);
        } else if (address.length == 6) {
            return [address.charCodeAt(i)&0xff for (i in address.slice(0, -2))].join('.');
        } else {
            throw Error('wrong peer address length ' + address.length);
        }
    },
    
    decodePort: function(address){
        var port = address.slice(-2);
        return ((port.charCodeAt(0)&0xff) << 8) + (port.charCodeAt(1)&0xff);
    },
    
    start: function(){
        var that = this;
        console.info('starting torrent ' + this.torrentPath);
        fs.readFile(this.torrentPath, 'binary', (function startTorrentCallback(error, contents){
            if (error) {
                console.error('could not open torrent file ' + this.torrentPath + ': ' + error);
                console.exception(error);
            }
            else {
                console.debug('metainfo: '+escape(contents));
                this.metaInfo = bencode.decode(contents);
                if ('comment' in that.metaInfo) {
                    console.log('Torrent \'' + this.metaInfo.comment + '\'');
                }
                this.metaInfo.info_hash = this.computeHash(this.metaInfo.info);
                this.store = new filestore.Store(this.metaInfo, this.destDir);
                console.log('inspecting files');
                this.store.inspect((function (error){
                    if (error) {
                        console.error('could not inspect torrent files ' + error);
                        console.exception(error);
                    }
                    else {
                        console.log('finished inspecting files.');
                        listener.create(this.listenerPort, that);
                        this.trackerClients = tracker.create(this.metaInfo);
                        for (i in this.trackerClients) {
                            this.pingTracker(this.trackerClients[i]);
                        }
                        
                        timer.setInterval((function(){
                            //hey why not do a totally unoptimized super duper crappy whatnot
                            var pieces = { //piece_index: number_of_peers_have_it
                            };
                            
                            /* Find all the pieces that the peers have */
                            for (var i in this.peers) { //iterate through peers,
                                that.peers[i].getBitfield().getBitArray().forEach(function(val, index){ //loop through their bitfield
                                    pieces[index] = (pieces[index] || 0) + (+val); //add it to a map of pieces (since zero = dont have, 1 = have, adding works)
                                })
                            }
                            
                            // Delete any pieces that are in request queue
                            // & Purge pieces queue of any pieces > 120 seconds after requested not recieved.
                            for (i in that.piecesQueue) {
                                if (that.piecesQueue[i] < (new Date().getTime() - 15 * 1000)) {
                                
                                    delete that.piecesQueue[i];
                                    
                                    for (j in that.peers) {
                                    
                                        var piecelength = (i == that.store.pieceCount - 1) ? that.store.lastPieceLength : that.store.pieceLength;
                                        
                                        for (var start = 0; start < piecelength; start += Math.pow(2, 15)) {
                                            that.peers[j].sendCancel(i, start, ((start + Math.pow(2, 15)) <= piecelength ? Math.pow(2, 15) : (piecelength - start)));
                                        }
                                    }
                                    
                                    console.log('piece #' + i + ' timed out');
                                    
                                }
                                delete pieces[i];
                            };
                            
                            
                            var pieces_array = [];
                            that.store.goodPieces.getBitArray().forEach(function(v, i){ //loop through my bitfield
                                if (v == 0 && pieces[i]) {
                                    //console.debug('piece index: '+i+' == i no haz');
                                    pieces_array.push(i); //if I don't have it, and somebody else haz it, then add the index to pieces array
                                }
                                else
                                    if (v == 1) {
                                        delete that.piecesQueue[i];
                                        //console.debug('piece index: '+i+' == i haz');
                                    }
                            });
                            
                            
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
                            console.debug('pieces sorted by availability (rarest first). ('+pieces_array.length+') :'+pieces_array.join(', '));
                            
                            var peers_random = [];
                            for (i in that.peers) {
                                peers_random.push(that.peers[i]);
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
                                    if (peers_random[i].getBitfield().getBitArray()[val] /*&& !peers_random[i].peerChoked*/ && !that.piecesQueue[val]) {
                                    
                                        peers_random[i].interested = true;
                                        peers_random[i].choked =false;
                                        
                                        var piecelength = (val == that.store.pieceCount - 1) ? that.store.lastPieceLength : that.store.pieceLength;
                                        
                                        for (var start = 0; start < piecelength; start += Math.pow(2, 15)) {
                                            peers_random[i].sendRequest(val, start, ((start + Math.pow(2, 15)) <= piecelength ? Math.pow(2, 15) : (piecelength - start)));
                                            // Too verbose
                                            //sys.log('requesting ('+[val, start, ((start+Math.pow(2,15)) <= piecelength ? Math.pow(2,15) : (piecelength-start))].join(', ')+')');
                                        
                                        }
                                        
                                        // Add piece to the list of pieces that are being queued.
                                        that.piecesQueue[val] = new Date().getTime();
                                        
                                        peers_random[i].log('requested for part ' + val);
                                        break;
                                    }
                                }
                            });
                            
                            var gotParts = that.store.goodPieces.getBitArray().filter(function(val){
                                return val == '1';
                            }).length;
                            var totalParts = that.store.pieceCount
                            
                            
                            console.log(gotParts + "/" + totalParts + " recieved (" + (Math.floor((gotParts / totalParts) * 100 * 100) / 100) + "%)");
                            
                            
                            
                            /* SEND REQUESTS TO PEERS HERE */
                            
                            var request;
                            
                            for (i in that.peers) {
                                for (j = 0, peer = that.peers[i]; j < peer.requests.length; j++) {
                                    request = peer.requests[j];
                                    if (that.store.goodPieces.getBitArray()[request.index] == '1') {
                                        this.store.readPiecePart(request.index, request.begin, request.length, function(err, data){
                                            if (err) {
                                                console.error('error reading piece part to send to peer');
                                            }
                                            else {
                                                peer.sendPiece(request.index, request.begin, data);
                                                console.log('successfully sent piece ' + request.index + ' to ' + peer.host);
                                            }
                                        });
                                    }
                                    else {
                                        console.log('peer requested for part ' + request.index + ', but I do not have it.');
                                    }
                                }
                                peer.requests = [];
                            }
                            
                            console.log('# of peers: ' + Object.keys(this.peers).length);
                            
                        }).bind(this), 5000);
                        
                        timer.setInterval((function(){
                            console.log('sent keepalives');
                            for (var i in this.peers) {
                                this.peers[i].sendKeepalive();
                            }
                        }).bind(this), 30000);
                        
                    }
                }).bind(this));
            }
        }).bind(this));
    }
};

exports.Torrent = Torrent;

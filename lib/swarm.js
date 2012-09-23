const {Logged, esc} = require('./log');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const {Socket} = require('net');
const {Class} = require('heritage');
const {Peer} = require('./peer');

'use strict'

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

function decodeAddress(address) {
    return decodeHost(address) + ':' + decodePort(address);
}

function generatePeerId() {
    return ('-JS0001-' + Math.random().toString(36).substr(3) + Math.random().toString(36).substr(3)).substr(0, 20);
}

exports.generatePeerId = generatePeerId;

function choice(arr, count) {
    let source = [arr[key] for (key in arr)];
    let results = [];
    for (var i=0; i<count && source.length > 0; ++i) {
        let index = Math.floor(source.length * Math.random());
        let elem = source[index];
        source.splice(index, 1);
        results.push(elem);
    }
    return count === 1 ? results[0] : results;
}

const Swarm = Class({
    implements: [Logged, EventTarget],
    name: 'Swarm',

    initialize: function(options) {
        this.peers = {};
        this.metadataPeers = {};
        this.infoHash = options.infoHash;
        this.peerId = options.peerId;
        this.tag = esc(this.infoHash) + ' ' + esc(this.peerId);
        this.peerAddresses = new Set();
        this.available = {};
    },

    get webInfo () {
        return {
            'peerCount': Object.keys(this.peers).length,
            'metadataPeerCount': Object.keys(this.metadataPeers).length,
            'available': this.available
        };
    },

    newIncomingPeer: function(peer) {
        this.sendHandshake(peer);
        if (peer.supportsExtended) {
            peer.sendExtendedHandshake();
        }
        this.addPeer(peer);
    },

    sendHandshake: function(peer) {
        peer.on('extension', (function(extension) {
            if (extension === 'ut_metadata') {
                this.metadataPeers[peer.peerId] = peer;
                this.debug('new metadata peer '+esc(peer.peerId)+' metadataPeers.length='+Object.keys(this.metadataPeers).length);
                peer.on('metadata-size', emit.bind(null, this, 'metadata-size'));
                peer.on('metadata-piece', emit.bind(null, this, 'metadata-piece'));
            }
            // Silently ignore other extensions
        }).bind(this));

        peer.on('bitfield', (function (bitfield) {
            let array = bitfield.getBitArray();
            for (let piece in array) {
                if (array[piece]) {
                    this.onHave(piece);
                }
            }
        }).bind(this));
        peer.on('have', this.onHave.bind(this));
        peer.on('piecefragment', emit.bind(null, this, 'piecefragment'));
        peer.on('request', emit.bind(null, this, 'request', peer));

        peer.sendHandshake(this.infoHash, this.peerId);
    },

    onHave: function(piece) {
        this.available[piece] = (this.available[piece] || 0) + 1; //add it to a map of pieces (since zero = dont have, 1 = have, adding works)
        this.debug('availability for piece '+piece+' is '+this.available[piece]);
        emit(this, 'have', piece);
    },
 
    addPeerAddress: function(peerAddress){
        if (!this.peerAddresses.has(peerAddress)) {
            try {
                let conn = Socket();
                conn.on('connect', (function() {
                    let peer = new Peer(conn);
                    peer.on('handshake', (function () {
                        if (peer.supportsExtended) {
                            peer.sendExtendedHandshake();
                        }
                        this.addPeer(peer);
                    }).bind(this));
                    this.sendHandshake(peer);
                }).bind(this));
                conn.on('error', (function(e) {
                    this.info('connection to peer '+decodeAddress(peerAddress)+' aborted: '+e);
                    this.peerAddresses.delete(peerAddress);
                }).bind(this));
                this.peerAddresses.add(peerAddress);
                this.debug('connecting to peer '+decodeAddress(peerAddress));
                conn.connect(decodePort(peerAddress), decodeHost(peerAddress));
            } catch (e) {
                this.error('exception while creating peer '+e);
                console.exception(e);
            }
        }
    },

    addPeer: function(peer) {
        this.debug('adding peer '+esc(peer.peerId));
        let oldPeer = this.peers[peer.peerId];
        if (oldPeer !== undefined) {
            this.warn('duplicate connection from peer '+esc(peer.peerId));
            oldPeer.abort();
        }
        peer.on('error', this.removePeer.bind(this, peer));
        this.peers[peer.peerId] = peer;
    },

    removePeer: function(peer, error){
        console.exception(error);
        this.info('removing peer '+esc(peer.peerId));
        let array = peer.goodPieces.getBitArray();
        for (piece in array) {
            if (array[piece]) {
                this.available[piece] = (this.available[piece] || 1) - 1;
                if (this.available[piece] === 0) {
                    delete this.available[piece];
                }
            }
        }
        delete this.peers[peer.peerId];
        delete this.metadataPeers[peer.peerId];
    },

    start: function() {
        this.keepaliveLoop = timers.setInterval(this.sendKeepalives.bind(this), 30000);
    },

    havePiece: function(index) {
        for each (let peer in this.peers) {
            peer.have(index);
        }
    },

    sendKeepalives: function() {
        this.info('sending keepalives');
        for each (let peer in this.peers) {
            peer.sendKeepalive();
        }
    },
 
    requestPieceFragment: function(piece, offset, size) {
        this.debug('trying to request piece '+piece+' fragment with offset '+offset+' and size '+size);
        for each (let peer in choice(this.peers, Object.keys(this.peers).length)) {
            //this.debug('peer '+peer.tag+' have pieces '+ JSON.stringify(peer.pieces));
            if (peer.pieces[piece] /*&& !peers_random[i].peerChoked*/) {
                peer.interested = true;
                peer.choked = false;

                if (peer.peerChoked) {
                    this.debug('peer '+peer.tag+' choked, skipping');
                    continue;
                }
                peer.sendRequest(piece, offset, size);

                peer.info('requested piece '+piece+' fragment with offset '+offset+' and size '+size);
                return;
            }
        }
        this.info('no peer to request piece '+piece+' fragment');
    },

    requestMetadataPiece: function(index) {
        if (Object.keys(this.metadataPeers).length === 0) {
            this.warn('no peers to request metadata');
        } else {
            // send piece request to 2 random peers
            let randomPeers = choice(this.metadataPeers, 2);
            this.debug('requesting metadata piece '+index+' from '+[peer for each (peer in randomPeers)].join(',')+'. randomPeers.length='+randomPeers.length+' metadataPeers.length='+Object.keys(this.metadataPeers).length);
            for each (peer in randomPeers) {
                peer.sendMetadataRequest(index);
            }
        }
    }
});

exports.Swarm = Swarm;

const bitfield = require('./bitfield');
const net = require('net');
const bencode = require('bencode');
var {escape, Logged} = require('log');
const {Class} = require('heritage');
 
function encodeInt(i){
    return String.fromCharCode(0xff & (i >> 24)) +
    String.fromCharCode(0xff & (i >> 16)) +
    String.fromCharCode(0xff & (i >> 8)) +
    String.fromCharCode(0xff & i);
}
        
function readInt(s, offset){
    offset = offset || 0;
    if (s.length < offset + 4) {
        throw new Error('expected 4 bytes.');
    }
    return (s.charCodeAt(offset) << 24) |
        (s.charCodeAt(offset + 1) << 16) |
        (s.charCodeAt(offset + 2) << 8) |
        s.charCodeAt(offset + 3);
}

function requestEqual(a, b){
    return a.index == b.index &&
    a.begin == b.begin &&
    a.length == b.length;
}

let extensions = {
    ut_metadata: Class({
        initialize: function(id) {
            this.id = id ? id : this.id;
        },
        name: 'ut_metadata',
        id: 2,
        handle: function(peer, message, payload) {
            peer[{
                0: 'handleMetadataRequest',
                1: 'handleMetadataData',
                2: 'handleMetadataReject'}[message.msg_type]].call(peer, message, payload);
        },
        handleHandshake: function(peer, message) {
            peer.torrent.setMetadataSize(message['metadata_size']);
        }
    })
};

const Peer = Class({
    implements: [Logged],
    name: 'Peer',
    initialize: function(key, host, port, torrent, connection){
        this.host = host;
        this.port = port;
        this.peerChoked = true;
        this.peerInterested = false;
        this.info('creating');
        this.stream = connection || net.createConnection(port, host);
        this.header = String.fromCharCode(19) + 'BitTorrent protocol';
        this.flagBytes = '\0\0\0\0\0\x10\0\0';
        this.input = '';
        this.needHeader = true;
        this.goodPieces = bitfield.create(torrent.store ? torrent.store.pieceCount : 0);
        this.amInterested = false;
        this.amChoked = true;
        this.torrent = torrent;
        this.key = key;
        this.requests = [];
        this.metadataRequests = [];
        this.extensions = {};

        this.stream.on('connect', this.onconnect.bind(this));
        this.stream.on('error', this.onerror.bind(this));
        this.stream.on('data', this.ondata.bind(this));
        this.stream.on('end', this.onend.bind(this));
        this.tag = this.host+':'+this.port;
    },
 
    setPieceCount: function(count) {
        this.goodPieces = bitfield.create(count);
    },

    getBitfield: function(){
        return this.goodPieces;
    },
    checkHeader: function(text){
        return (text.substring(0, 20) === this.header && text.substring(28, 48) === this.torrent.infoHash);
    },
    onconnect: function () {
        var firstPacket = this.header + this.flagBytes + this.torrent.infoHash + this.torrent.peerId;
        this.info('sending handshake');
        this.stream.write(firstPacket, 'binary');
    },
    onerror: function(e) {
        this.info('error: ' + e.message);
        this.stream.end();
        this.torrent.removePeer(this.key);
    },
    onend: function(){
        this.info('end');
        this.torrent.removePeer(this.key);
    },
    
    doHave: function(data){
        var piece = readInt(data);
        this.debug('have ' + piece);
        this.goodPieces.set(piece, true);
    },
    
    doBitfield: function(data){
        this.debug('doBitfield');
        this.goodPieces.setWire(data);
    },
    
    readRequest: function(data){
        let index = readInt(data, 0);
        let begin = readInt(data, 4);
        let length = readInt(data, 8);
        let pieceLength = this.torrent.store.pieceLength;
        let pieceCount = this.torrent.store.pieceCount;
        this.info('peer requested piece ' + index);
        if (!((begin >= 0 && begin + length <= pieceLength) &&
            (length > 0 && length <= 32 * 1024) &&
            (index >= 0 && index < pieceCount))) {
            throw Error("request bad parameters");
        }
        return {
            index: index,
            begin: begin,   
            length: length
        };
    },
    
    doRequest: function(data){
        this.debug('doRequest');
        var request = this.readRequest(data);
        if (this.requests.every(function(r) {
            return !requestEqual(r, request);
        })) {
            this.requests.push(request);
        } else {
            this.debug('duplicate request for piece '+request.index);
        }
    },
    
    doPiece: function(data){
        var index = readInt(data, 0);
        var begin = readInt(data, 4);
        var block = data.substring(8);
        this.torrent.addPieceFragment(index, offset, data);
    },

    doCancel: function(data){
        this.debug('doCancel');
        var request = this.readRequest(data);
        this.requests.forEach(function(r, i) {
            if (requestEqual(r, request)) {
                request.splice(i, 1);
            }
        });
    },

    handleExtended: function(data) {
        this.trace('received extended protocol data');
        var id = data.charCodeAt(0);
        var [message,payload] = bencode.decode(data.slice(1), {withLeftover: true});
        if (id == 0) {
            for (extName in message.m) {
                this.debug('peer supports extension '+extName);
                if (extName in extensions) {
                    this.info('handshaked extension '+extName);
                    var id = message.m[extName];
                    var extension = extensions[extName](id);
                    if (id in this.extensions) {
                        this.error('id '+id+' already registered for extension '+this.extensions[id].name);
                    } else {
                        this.extensions[id] = this.extensions[extName] = extension; // for quick access
                        this.torrent.addPeerExtension(this, extName);
                        extension.handleHandshake(this, message);
                    }
                }
            }
        } else {
            if (!(id in this.extensions)) {
                this.error('no registered extension supports id '+id);
                return;
            } else {
                this.extensions[id].handle(this, message, payload);
            }
        }
    },

    handleMetadataRequest: function(message) {
        let piece = message.piece;
        this.debug('received metadata request for piece '+piece);
        if (!this.metadataRequests.contains(piece)) {
            this.metadataRequests.push(piece);
        } else {
            this.debug('duplicate request for metadata piece '+piece);
        }
    },

    handleMetadataData: function(message, payload) {
        this.debug('received metadata piece '+message.piece+' with length '+payload.length);
        this.torrent.addMetadataPiece(message.piece, payload);
    },

    handleMetadataReject: function(message) {
        this.debug('peer does not have metadata piece '+message.piece);
    },
 
    // returns true if a message was processed
    processMessage: function(){
        var input = this.input;
        if (this.needHeader) {
            if (input.length < 68) {
                return false;
            }
            if (this.checkHeader(input)) {
                this.peerId = input.substring(48, 68);
                this.input = input.substring(68);
                this.peerFlags = input.substring(20, 28); 
                this.needHeader = false;
                this.debug('received header: peerId='+this.peerId+' flags='+escape(this.peerFlags));
                if (this.peerFlags.charCodeAt(5) & 0x10) {
                    this.debug('peer supports extension protocol');
                    this.sendExtendedHandshake();
                }
                return true;
            } else {
                this.info('header is invalid: '+escape(input.substring(0, 48))+' expecting '+escape(this.header+this.flagBytes+this.torrent.infoHash));
                throw new Error('header is invalid');
            }
            return false;
        }
        if (input.length < 4) {
            this.trace('input length < 4');
            return false;
        }
        var dataLen = readInt(input);
        if (input.length < dataLen + 4) {
            this.trace('input length < '+(dataLen + 4));
            return false;
        }
        if (dataLen == 0) {
            // Keep alive;
            this.info("received keep alive");
        } else {
            var id = input.charCodeAt(4);
            payload = input.substring(5, 4 + dataLen);
            if (id == 0) {
                this.debug('received choked');
                this.peerChoked = true;
            } else if (id == 1) {
                this.debug('received unchoked');
                this.peerChoked = false;
            } else if (id == 2) {
                this.debug('received interested');
                this.peerInterested = true;
            } else if (id == 3) {
                this.debug('received uninterested');
                this.peerInterested = false;
            } else if (id == 4) {
                this.doHave(payload);
            } else if (id == 5) {
                this.doBitfield(payload);
            } else if (id == 6) {
                this.doRequest(payload);
            } else if (id == 7) {
                this.doPiece(payload);
            } else if (id == 8) {
                this.doCancel(payload);
            } else if (id == 9) {
                this.debug("DHT listen-port");
            } else if (id == 20) {
                this.handleExtended(payload);
            } else {
                this.info('received message with unknown id '+id+' and length '+dataLen);
                // May want to silently ignore
                throw new Error('unknown request ' + id);
            }
        }
        this.input = input.substring(4 + dataLen);
        return true;
    },
        
    ondata: function(data){
        //this.debug('received '+data.length+' bytes: '+escape(data));
        this.debug('received '+data.length+' bytes');

        this.input += data;
        try {
            while (this.processMessage()) 
                ;
        } catch (e) {
            this.error('exception while handling message', e);
            this.stream.end();
            this.torrent.removePeer(this.key);
        }
    },
       
    writePacket: function(op, payload){
        if (op === 0) {
            this.stream.write(encodeInt(0), 'binary');
        } else {
            payload = payload || '';
            this.stream.write(encodeInt(payload.length + 1) + String.fromCharCode(op) + payload, 'binary');
        }
    },
    get choked () {
        return this.amChoked;
    },
    set choked (state){
        if (state != this.amChoked) {
            this.amChoked = state;
            this.debug('sending choked flag '+state);
            this.writePacket(state ? 0 : 1);
        }
    },
    get interested () {
        return this.amInterested;
    },
    set interested (state){
        this.debug('setting interested flag to '+state);
        if (state !== this.amInterested) {
            this.amInterested = state;
            this.debug('sending interested flag '+state);
            this.writePacket(state ? 2 : 3);
        }
    },
    have: function(index){
        this.debug('sending have '+index);
        this.writePacket(4, encodeInt(index));
    },
    sendBitfield: function(){
        this.debug('sending bitfield');
        this.writePacket(5, this.torrent.store.goodPieces.getWire());
    },
    sendRequest: function(index, begin, length){
        this.debug('sending request for '+index+'['+begin+':'+(begin+length)+']');
        this.writePacket(6, encodeInt(index) + encodeInt(begin) + encodeInt(length));
    },
    sendPiece: function(index, begin, data){
        this.debug('sending piece '+index+' from offset '+begin+' with length '+data.length);
        this.writePacket(7, encodeInt(index) + encodeInt(begin) + data);
    },
    sendCancel: function(index, begin, length){
        this.debug('sending cancel for piece '+index+' from offset '+begin+' with length '+length);
        this.writePacket(8, encodeInt(index) + encodeInt(begin) + encodeInt(length));
    },
    sendKeepalive: function(){
        this.debug('sending keepalive');
        this.writePacket(0);
    },
    sendMetadataRequest: function(piece) {
        this.debug('sending metadata request for piece '+piece);
        this.sendExtended('ut_metadata', {msg_type: 0, piece: piece});
    },
    sendMetadataReject: function(piece) {
        this.debug('sending metadata reject for piece '+piece);
        this.sendExtended('ut_metadata', {msg_type: 2, piece: piece});
    },
    sendMetadataData: function(piece, data, totalSize) {
        this.debug('sending metadata for piece '+piece+' with length '+data.length);
        this.sendExtended('ut_metadata', {msg_type: 1, total_size: totalSize}, data);
    },
    sendExtendedHandshake: function() {
        let m = {};
        for (let extName in extensions) {
            m[extName] = extensions[extName]().id;
        }
        this.debug('sending extension protocol handshake m='+JSON.stringify(m));
        this.sendExtended(0, {'m': m}); 
    },
    sendExtended: function(idOrName, dict, payload='') {
        let id = idOrName;
        if (typeof id === 'string') {
            id = this.extensions[idOrName].id;
        }
        this.writePacket(20, String.fromCharCode(id) + bencode.encode(dict) + payload);
    }
});

exports.Peer = Peer;

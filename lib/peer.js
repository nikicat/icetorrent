const bitfield = require('./bitfield');
//const { net } = require('io');
const net = require('./net');
const bencode = require('bencode');
const {esc, Logged} = require('./log');
const {Class} = require('heritage');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
 
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
            emit(peer, 'metadata-size', message['metadata_size']);
        }
    })
};

const Peer = Class({
    implements: [Logged, EventTarget],
    name: 'Peer',
    initialize: function(conn){
        this.tag = conn.host+':'+conn.port;
        this.stream = conn;
        this.info('creating');
        this.peerChoked = true;
        this.peerInterested = false;

        this.header = String.fromCharCode(19) + 'BitTorrent protocol';
        this.flagBytes = '\0\0\0\0\0\x10\0\0';
        this.input = '';
        this.needHeader = true;
        this.goodPieces = bitfield.create(0);
        this.amInterested = false;
        this.amChoked = true;
        this.requests = [];
        this.metadataRequests = [];
        this.supportsExtended = false;
        this.extensions = {};

        this.stream.on('readyState', (function(state) { this.trace('socket state changed to '+state); }).bind(this));
        this.stream.on('error', this.onerror.bind(this));
        this.stream.on('data', this.ondata.bind(this));
        this.stream.on('close', this.onclose.bind(this));
    },

    get webInfo() {
        return {
            host: this.conn.host,
            port: this.conn.port
        }
    },
 
    setPieceCount: function(count) {
        this.trace('set count='+count);
        this.goodPieces = bitfield.create(count, this.goodPieces.getWire());
        //this.trace('goodPieces='+JSON.stringify(this.goodPieces.getBitArray()));
    },

    getBitfield: function(){
        return this.goodPieces;
    },

    abort: function() {
        this.stream.end();
    },

    sendHandshake: function (infoHash, peerId) {
        this.debug('sending handshake');
        var firstPacket = this.header + this.flagBytes + infoHash + peerId;
        this.stream.write(firstPacket, 'binary');
    },
    onerror: function(e) {
        this.error('error: '+e);
        this.stream.end();
    },
    onclose: function(){
        this.info('close');
        emit(this, 'close');
    },
    
    handleHave: function(data){
        let piece = readInt(data);
        this.debug('have ' + piece);
        this.goodPieces.set(piece, 1);
        //this.debug('goodPieces='+JSON.stringify(this.goodPieces.getBitArray()));
        emit(this, 'have', piece);
    },
    
    handleBitfield: function(data){
        this.debug('received bitfield message '+esc(data));
        this.goodPieces.setWire(data);
        this.trace('goodPieces='+JSON.stringify(this.goodPieces.getBitArray()));
        this.trace('new goodPieces='+JSON.stringify(bitfield.create(0, data).getBitArray()));
        emit(this, 'bitfield', this.goodPieces);
    },
    
    readRequest: function(data){
        let index = readInt(data, 0);
        let begin = readInt(data, 4);
        let length = readInt(data, 8);
        //let pieceLength = this.torrent.store.pieceLength;
        //let pieceCount = this.torrent.store.pieceCount;
        //if (!((begin >= 0 && begin + length <= pieceLength) &&
        //    (length > 0 && length <= 32 * 1024) &&
        //    (index >= 0 && index < pieceCount))) {
        //    throw new Error("request bad parameters");
        //}
        return {
            index: index,
            begin: begin,   
            length: length
        };
    },
    
    handleRequest: function(data){
        let request = this.readRequest(data);
        this.debug('received request for piece '+request.index);
        if (this.requests.every(function(r) {
            return !requestEqual(r, request);
        })) {
            this.requests.push(request);
            emit(this, 'piecerequest', request);
        } else {
            this.debug('duplicate request for piece '+request.index);
        }
    },
    
    handlePiece: function(data){
        let index = readInt(data, 0);
        let begin = readInt(data, 4);
        let block = data.substring(8);
        this.debug('received piece '+index+' begin at '+begin+' length '+block.length);
        emit(this, 'piecefragment', index, begin, block);
    },

    handleCancel: function(data){
        var request = this.readRequest(data);
        this.debug('received cancel for piece '+request.index);
        this.requests.forEach(function(r, i) {
            if (requestEqual(r, request)) {
                request.splice(i, 1);
            }
        });
    },

    handleExtended: function(data) {
        this.debug('received extended protocol data');
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
                        emit(this, 'extension', extName);
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
        emit(this, 'metadata-piece', message.piece, payload);
    },

    handleMetadataReject: function(message) {
        this.debug('peer does not have metadata piece '+message.piece);
    },

    handleHandshake: function(message) {
        let header = message.substring(0, 20);
        if (header !== this.header) {
            throw new Error('unexpected header '+header+'. expected '+this.header+'.');
        }
        this.peerFlags = message.substring(20, 28); 
        let infoHash = message.substring(28, 48);
        this.peerId = message.substring(48, 68);
        this.debug('received handshake: peerId='+esc(this.peerId)+' flags='+esc(this.peerFlags));
        if (this.peerFlags.charCodeAt(5) & 0x10) {
            this.debug('peer supports extension protocol');
            this.supportsExtended = true;
        }
        emit(this, 'handshake', infoHash); 
    },
 
    // returns true if a message was processed
    processMessage: function(){
        if (this.needHeader) {
            if (this.input.length < 68) {
                return false;
            }
            this.handleHandshake(this.input.substring(0, 68));
            this.input = this.input.substring(68);
            this.needHeader = false;
        }
        if (this.input.length < 4) {
            this.debug('input length < 4');
            return false;
        }
        var dataLen = readInt(this.input);
        if (this.input.length < dataLen + 4) {
            this.debug('input length < '+(dataLen + 4));
            return false;
        }
        if (dataLen == 0) {
            // Keep alive;
            this.debug("received keep alive");
        } else {
            var id = this.input.charCodeAt(4);
            payload = this.input.substring(5, 4 + dataLen);
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
                this.handleHave(payload);
            } else if (id == 5) {
                this.handleBitfield(payload);
            } else if (id == 6) {
                this.handleRequest(payload);
            } else if (id == 7) {
                this.handlePiece(payload);
            } else if (id == 8) {
                this.handleCancel(payload);
            } else if (id == 9) {
                this.warning("received unimplemented DHT listen-port");
            } else if (id == 20) {
                this.handleExtended(payload);
            } else {
                this.warning('received message with unknown id '+id+' and length '+dataLen);
                // May want to silently ignore
                throw new Error('unknown request ' + id);
            }
        }
        this.input = this.input.substring(4 + dataLen);
        return true;
    },
        
    ondata: function(data){
        this.input += data;
        try {
            while (this.processMessage()) 
                ;
        } catch (e) {
            console.exception(e);
            this.onerror('error', e);
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
        this.debug('setting choked flag to '+state);
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
    get pieces() {
        return this.goodPieces.getBitArray();
    },
    have: function(index){
        this.debug('sending have '+index);
        this.writePacket(4, encodeInt(index));
    },
    sendBitfield: function(pieces){
        this.debug('sending bitfield='+pieces.getBitArray());
        this.writePacket(5, pieces.getWire());
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

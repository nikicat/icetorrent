var bitfield = require('./bitfield');
var net = require('net');
var {escape} = require('log');

function Peer(key, host, port, torrent, connection){
    this.tag = 'Peer<'+host+':'+port+'>: ';
    this.log('creating');
    this.stream = connection || net.createConnection(port, host);
    this.header = String.fromCharCode(19) + 'BitTorrent protocol';
    this.flagBytes = '\0\0\0\0\0\0\0\0';
    this.input = '';
    this.needHeader = true;
    this.goodPieces = bitfield.create(torrent.store.pieceCount);
    this.amInterested = false;
    this.amChoked = true;
    this.peerInterested = false;
    this.peerChoked = true;
    this.torrent = torrent;
    this.key = key;
    this.requests = [];

    this.stream.setNoDelay();
    this.stream.setTimeout(0);
    this.stream.on('connect', this.onconnect.bind(this));
    this.stream.on('error', this.onerror.bind(this));
    this.stream.on('data', this.ondata.bind(this));
    this.stream.on('end', this.onend.bind(this));
}
 
function encodeInt(i){
    return String.fromCharCode(0xff & (i >> 24)) +
    String.fromCharCode(0xff & (i >> 16)) +
    String.fromCharCode(0xff & (i >> 8)) +
    String.fromCharCode(0xff & i);
}
        
function readInt(s, offset){
    offset = offset || 0;
    if (s.length < offset + 4) {
        throw Error('expected 4 bytes.');
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

Peer.prototype = {
    getBitfield: function(){
        return this.goodPieces;
    },
    checkHeader: function(text){
        return (text.substring(0, 20) === this.header && text.substring(28, 48) === this.torrent.metaInfo.info_hash);
    },
    debug: function(message) {
        console.debug(this.tag+message);
    },
    log: function(message) {
        console.log(this.tag+message);
    },
    onconnect: function () {
        var firstPacket = this.header + this.flagBytes + this.torrent.metaInfo.info_hash + this.torrent.peerId;
        this.log("connection established");
        this.stream.write(firstPacket, 'binary');
    },
    onerror: function(e) {
        this.log('error: ' + e);
        this.stream.end();
        this.torrent.removePeer(this.key);
    },
    onend: function(){
        this.log('end');
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
        var index = readInt(data, 0);
        var begin = readInt(data, 4);
        var length = readInt(data, 8);
        var pieceLength = this.torrent.store.pieceLength;
        var pieceCount = this.torrent.store.pieceCount;
        this.log('peer requested piece ' + index);
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
        var length = block.length;
        var torrent = this.torrent;
        var pieceLength = torrent.store.pieceLength;
        var pieceCount = torrent.store.pieceCount;
        if (!((begin >= 0 && begin + length <= pieceLength) &&
            (length > 0 && length <= 32 * 1024) &&
            (index >= 0 && index < pieceCount))) {
            this.log('oh crap bad piece params');
            throw Error("piece bad parameters");
        }
        this.debug("received piece " + index +' ' + begin + ' ' + length); // Reduced verbosity
        
        if(!torrent.downloading[index])
            torrent.downloading[index] = {};
        torrent.downloading[index][begin] = true;
        
        torrent.store.writePiecePart(index, begin, block, this.pieceWritten.bind(this, index));
    },

    pieceWritten: function(index, err){
        if (err) {
            this.log('piece '+index+' writing failed: '+err);
            console.exception(err);
            return;
        }
        this.debug('wrote piece ' + index + (err||"NO ERRORS FTW!")); // Reduced verbosity.
        var torrent = this.torrent;
        var pieceLength = torrent.store.pieceLength;
        
        var hasdone = 0;                
        for(var z in torrent.downloading[index])
            hasdone += +torrent.downloading[index][z];
        
        if(hasdone == Math.ceil(pieceLength/Math.pow(2, 15))){
            //sure hope this is right
            this.debug('yay done '+hasdone+' out of about '+Math.ceil(pieceLength/Math.pow(2, 15)));
            this.debug(JSON.stringify(torrent.downloading));
            
            torrent.downloading[index] = {};
            delete torrent.downloading[index];
            
            torrent.store.inspectPiece(index, (function(error){
                if(!error){
                    this.log('wrote Piece #' + index);
                    torrent.store.goodPieces.set(index, 1); //change bitfield
                  delete torrent.piecesQueue[index]; // Delete from the pieces Queue
                  for (var i in torrent.peers) {
                      torrent.peers[i].have(index);
                  }
                } else {
                    this.debug('waah broken piece: '+error);
                    console.exception(error);
                }
            }).bind(this))
        
        } else {
            this.debug('not done yet')
        }
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
                this.needHeader = false;
                this.debug('header is valid');
                return true;
            }
            else {
                this.log('header is invalid: '+escape(input.substring(0, 48))+' expecting '+escape(this.header+this.flagBytes+this.torrent.metaInfo.info_hash));
                throw Error('header is invalid');
            }
            return false;
        }
        if (input.length < 4) {
            this.debug('input length < 4');
            return false;
        }
        var dataLen = readInt(input);
        this.debug('received message with size '+dataLen+' bytes');
        if (input.length < dataLen + 4) {
            this.debug('input length < '+(dataLen + 4));
            return false;
        }
        if (dataLen == 0) {
            // Keep alive;
            this.log("received keep alive");
        }
        else {
            var id = input.charCodeAt(4);
            this.debug('received message with id '+id);
            payload = input.substring(5, 4 + dataLen);
            if (id == 0) {
                this.debug('choked');
                this.peerChoked = true;
            } else if (id == 1) {
                this.debug('unchoked');
                this.peerChoked = false;
            } else if (id == 2) {
                this.debug('interested');
                this.peerInterested = true;
            } else if (id == 3) {
                this.debug('uninterested');
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
            } else {
                // May want to silently ignore
                throw Error('unknown request ' + id);
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
        } 
        catch (e) {
            console.exception(e);
            this.stream.end();
            this.torrent.removePeer(this.key);
        }
    },
       
    writePacket: function(op, payload){
        try {
            if (op === 0) {
                //stream.write('\0\0\0\0', 'binary');
                this.stream.write(encodeInt(0), 'binary');
            }
            else {
                payload = payload || '';
                this.stream.write(encodeInt(payload.length + 1) + String.fromCharCode(op) + payload, 'binary');
            }
        } 
        catch (err) {
            console.exception(err);
        }
    },
    get choked () {
        return this.amChoked;
    },
    set choked (state){
        if (state != this.amChoked) {
            this.amChoked = state;
            this.writePacket(state ? 0 : 1);
        }
    },
    get interested () {
        return this.amInterested;
    },
    set interested (state){
        if (state != this.amInterested) {
            this.amInterested = state;
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
        this.writePacket(7, encodeInt(index) + encodeInt(begin) + data);
    },
    sendCancel: function(index, begin, length){
        this.writePacket(8, encodeInt(index) + encodeInt(begin) + encodeInt(length));
    },
    sendKeepalive: function(){
        this.debug('sending keepalive');
        this.writePacket(0);
    }
};

exports.Peer = Peer;

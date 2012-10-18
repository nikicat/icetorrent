const {Logged, esc} = require('./log');
const {Class} = require('heritage');
const {Swarm, generatePeerId} = require('./swarm');
const {TrackerManager} = require('./tracker');
const querystring = require('querystring');
const timers = require('timers');
const {computeHash} = require('./util');
const bencode = require('bencode');
const base64 = require('base64');

function parse(uri) {
    let args = querystring.parse(uri.query);
    if (args.xt.substr(0, 9) !== 'urn:btih:') {
        throw Error('broken magnet: link: '+uri.spec);
    }
    let infoHash = args.xt.substr(9).replace(/([0-9A-Fa-f]{2})/g, function() String.fromCharCode(parseInt(arguments[1], 16)));
    return {
        dn: args.dn,
        tr: args.tr,
        infoHash: infoHash
    };
}

exports.parse = parse;

const MagnetLoader = Class({
    implements: [Logged],
    initialize: function(uri) {
        this.uri = uri;
        this.debug('query: '+uri.query);
        let parsed = parse(uri);
        this.dn = parsed.dn;
        this.tr = parsed.tr;
        this.infoHash = parsed.infoHash;
        this.tag = base64.encode(this.infoHash.slice(0,5));
        this.peerId = generatePeerId();
        this.debug('info hash: '+esc(this.infoHash));
        if (!this.tr) {
            this.error('magnet links without trackers are not supported (no DHT support)');
            throw new Error('magnet links without trackers are not supported (no DHT support)');
        }
        this.state = 'retrieving metadata size';

        this.trackers = TrackerManager({
            infoHash: this.infoHash,
            peerId: this.peerId,
            announce: this.tr[0],
            announceList: [this.tr.slice(1)]
        });

        this.swarm = Swarm({
            infoHash: this.infoHash,
            peerId: this.peerId
        });
        this.swarm.on('metadata-size', this.onMetadataSize.bind(this));
        this.swarm.on('metadata-piece', this.onMetadataPiece.bind(this));
        this.trackers.on('peeraddress', this.swarm.addPeerAddress.bind(this.swarm));
    },

    load: function(callback) {
        this.callback = callback;
        let metadata = this.loadFromCache();
        if (metadata === undefined) {
            this.trackers.start();
        } else {
            callback(metadata);
        }
    },

    loadFromCache: function() {

    },

    onMetadataSize: function(size) {
        if (this.metadataSize) {
            if (this.metadataSize !== size) {
                this.error('metadata size already set to '+this.metadataSize+', new size '+size);
            }
        } else {
            this.debug('setting metadata size to '+size);
            this.metadataSize = size;
            this.state = 'loading metadata';
            this.metadataPieces = Array(Math.ceil(size/16384));
            timers.setInterval(this.requestMetadata.bind(this), 10000);
            this.requestMetadata();
        }
    },

    requestMetadata: function() {
        try { 
            this.debug('checking metadata pieces to request');
            for (let i=0; i < this.metadataPieces.length; ++i) {
                if (this.metadataPieces[i] === undefined) {
                    this.swarm.requestMetadataPiece(i);
                }
            }
        } catch (e) {
            console.exception(e);
        }
    },

    onMetadataPiece: function(index, data) {
        this.debug('received metadata piece '+index+'. data size '+data.length);
        if (index >= this.metadataPieces.length || index < 0) {
            this.error('piece '+index+' out of range '+this.metadataPieces.length);
        } else if (index === this.metadataPieces.length - 1) {
            if (data.length % 16384 !== this.metadataSize % 16384) {
                this.error('invalid last piece length '+data.length+', correct is '+this.metadataSize % 16384);
            }
        } else {
            if (data.length !== 16384) {
                this.error('invalid length for non-last piece '+index+': '+data.length);
            }
        }
        let pieceData = this.metadataPieces[index];
        if (pieceData !== undefined) {
            if (pieceData !== data) {
                this.error('could not override metadata piece '+index+' with different data');
            } else {
                this.info('received duplicate metadata piece '+index);
            }
        } else {
            this.debug('storing metadata for piece '+index);
            this.metadataPieces[index] = data;
            if (this.metadataPieces.join('').length === this.metadataSize) {
                this.debug('all metadata pieces received, checking');
                try {
                    let metadata = this.metadataPieces.join('');
                    let infoHash = computeHash(bencode.decode(metadata));
                    let error = null;
                    if (infoHash != this.infoHash) {
                        throw new Error('metadata hash mismatch: expected '+this.infoHash+', actual '+infoHash);
                    }
                    this.state = 'loaded metadata';
                    this.debug('metadata loaded');
                    try {
                        this.callback(metadata);
                    } catch (e) {
                        console.exception(e);
                    }
                } catch (e) {
                    this.error('failed to verify metadata: '+e+'. redownloading.');
                    // Reset metadata pieces for redownloading
                    this.metadataPieces = Array(Math.ceil(this.metadataSize/16384));
                    return;
                }
            }
        }
    }
});

exports.MagnetLoader = MagnetLoader;

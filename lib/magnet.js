const {Logged, esc} = require('./log');
const {Class} = require('heritage');
const {Swarm, generatePeerId} = require('./swarm');
const {TrackerManager} = require('./tracker');
const querystring = require('querystring');
const timers = require('timers');
const {computeHash} = require('./util');
const bencode = require('bencode');

const MagnetLoader = Class({
    implements: [Logged],
    initialize: function(uri) {
        this.uri = uri;
        this.debug('query: '+uri.query);
        var args = querystring.parse(uri.query);
        if (args.xt.substr(0, 9) !== 'urn:btih:') {
            throw new Error('broken magnet: link: '+uri.spec);
        }
        this.magnet = args;
        this.infoHash = args.xt.substr(9).replace(/([0-9A-Fa-f]{2})/g, function() String.fromCharCode(parseInt(arguments[1], 16)));
        this.tag = esc(this.infoHash);
        this.peerId = generatePeerId();
        this.debug('info hash: '+esc(this.infoHash));
        if (!args.tr) {
            this.error('magnet links without trackers are not supported (no DHT support)');
            throw new Error('magnet links without trackers are not supported (no DHT support)');
        }
        this.state = 'retrieving metadata size';

        this.trackers = new TrackerManager({
            infoHash: this.infoHash,
            peerId: this.peerId,
            announce: args.tr[0],
            announceList: [args.tr.slice(1)]
        });

        this.swarm = new Swarm({
            infoHash: this.infoHash,
            peerId: this.peerId
        });
        this.swarm.on('metadata-size', this.onMetadataSize.bind(this));
        this.swarm.on('metadata-piece', this.onMetadataPiece.bind(this));
        this.trackers.on('peeraddress', this.swarm.addPeerAddress.bind(this.swarm));
    },

    load: function(callback) {
        this.callback = callback;
        this.trackers.start();
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
            this.debug('requesting metadata. metadataPieces.length='+this.metadataPieces.length);
            for (let i=0; i < this.metadataPieces.length; ++i) {
                //this.debug('metadataPieces['+i+']='+this.metadataPieces[i]);
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
        var pieceData = this.metadataPieces[index];
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
                    let metadata = bencode.decode(this.metadataPieces.join(''));
                    let infoHash = computeHash(metadata);
                    let error = null;
                    if (infoHash != this.infoHash) {
                        throw new Error('metadata hash mismatch: expected '+this.infoHash+', actual '+infoHash);
                    }
                    this.state = 'loaded metadata';
                    this.debug('metadata loaded');
                    this.callback(metadata);
                } catch (e) {
                    this.error('failed to verify metadata: '+e+'. redownloading.');
                    // Reset metadata pieces for redownloading
                    this.metadataPieces = Array(Math.ceil(this.metadataSize/16384));
                }
            }
        }
    }
});

exports.MagnetLoader = MagnetLoader;

'use strict';

const bencode = require('bencode');
const {Store} = require('./filestore');
const timers = require('timers');
const http = require('http');
const settings = require('simple-prefs').prefs;
const {Logged, esc} = require('log');
const {Class} = require('heritage');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const {computeHash} = require('./util');
const rpc = require('./rpc');
const base64 = require('base64');

function dumpObj(obj) {
    for (let key in Object.keys(obj)) {
        console.debug('this.peers['+key+']='+obj[key]);
    }
}

const fragmentSize = Math.pow(2, 14);


let torrentId = 0;

const Torrent = Class({
    implements: [Logged, EventTarget],
    name: 'Torrent',
    initialize: function(info, options) {
        this.id = torrentId++;
        this.metadata = info;
        this.infoHash = computeHash(info);
        this.tag = base64.encode(this.infoHash.slice(0,5));
        this.debug('info: '+esc(JSON.stringify(info)));

        this.addedDate = Date.now();
        this.activityDate = Date.now();
        this.comment = options.comment;
        this.name = info.name;

        this.swarm = options.swarm;

        this.downloadedEver = 0;
        this.haveValid = 0;
        this.corruptEver = 0;
        this.haveUnchecked = 0;

        this.store = Store(info);
        this.store.on('havepiece', this.swarm.havePiece.bind(this.swarm));
        this.store.on('havepiece', (function(piece) {
            this.downloadedEver += piece.length;
            this.haveValid += piece.length;
            if (this.leftUntilDone === 0) {
                this.state = 'finished';
            }
        }).bind(this));
        this.store.on('corruptpiece', (function(piece) {
            this.haveUnchecked -= piece.length;
            this.corruptEver += piece.length;
        }).bind(this));
        this.store.on('piecefragment', (function(index, offset, data) {
            this.haveUnchecked += data.length;
        }).bind(this));
        // TODO: use event-based item requesting instead of polling
        //this.store.on('needpiece', this.onNeedPiece.bind(this));
        this.store.on('data', emit.bind(this, 'data'));
        this.store.on('end', emit.bind(this, 'end'));
        this.store.on('changed', emit.bind(null, this, 'changed'));
        this.swarm.on('piecefragment', this.store.addPieceFragment.bind(this.store));
        this.swarm.on('request', (function (peer, index, offset, length) {
            if (this.store.havePiece(index)) {
                this.store.readPiecePart(index, offset, length, function (error, data) {
                    if (!error) {
                        peer.sendPiece(index, offset, data);
                    }
                });
            }
        }).bind(this));
        this.swarm.on('changed', emit.bind(null, this, 'changed'));

        this.trackers = options.trackerManager;
        this.trackers.on('peeraddress', this.swarm.addPeerAddress.bind(this.swarm));

        this._state = 'initialized';
        this.debug('initialized');
    },
    get tag() {
        return this.infoHash ? base64.encode(this.infoHash.slice(0, 5)).slice(0, -1) : 'unset';
    },
    get state() {
        return this._state;
    },
    set state(_state) {
        this._state = _state;
        emit(this, 'changed');
    },

    get leftUntilDone() {
        let left = 0;
        for each (let file in this.store.files) {
            if (file.wanted) {
                left += file.length - file.bytesCompleted;
            }
        }
        return left;
    },

    get sizeWhenDone() {
        let total = 0;
        for each (let file in this.store.files) {
            if (file.wanted) {
                total += file.length;
            }
        }
        return total;
    },

    get percentDone() {
        return 1 - this.leftUntilDone/this.sizeWhenDone;
    },

    get desiredAvailable() {
        let avail = 0;
        for each (let file in this.store.files) {
            if (file.wanted) {
                for each (let piece in file.pieces) {
                    if (!piece.good && this.swarm.available[piece.index] > 0) {
                        avail += piece.length;
                    }
                }
            }
        }
        return avail;
    },

    getFields: function(fields) {
        let data = {
            activityDate: this.activityDate,
            addedDate: this.addedDate,
            bandwidthPriority: 0,
            comment: this.comment,
            corruptEver: this.corruptEver,
            creator: '',
            dateCreated: 0,
            desiredAvailable: this.desiredAvailable,
            doneDate: this.doneDate,
            downloadDir: this.store.downloadDir,
            downloadedEver: this.downloadedEver,
            downloadLimit: 0,
            downloadLimited: false,
            error: 0,
            errorString: '',
            eta: 0,
            files: [{
                bytesCompleted: file.bytesCompleted,
                length: file.length,
                name: file.name
            } for each (file in this.store.files)],
            fileStats: [{
                bytesCompleted: file.bytesCompleted,
                wanted: file.wanted,
                priority: 0
            } for each (file in this.store.files)],
            hashString: base64.encode(this.infoHash),
            haveUnchecked: this.haveUnchecked,
            haveValid: this.haveValid,
            honorSessionLimits: false,
            id: this.id,
            isFinished: this.state === 'finished',
            isPrivate: false,
            isStalled: false,
            leftUntilDone: this.leftUntilDone,
            magnetLink: 0,
            manualAnnounceTime: 0,
            maxConnectedPeers: 0,
            metadataPercentComplete: 100.0,
            name: this.metadata.name,
            'peer-limit': 0,
            peers: [{
                address: peer.address,
                clientName: peer.peerId,
                clientIsChoked: peer.amChoked,
                clientIsInterested: peer.amInterested,
                flagStr: peer.peerFlags,
                isDownloadingFrom: false,
                isEncrypted: false,
                isIncoming: false,
                isUploadingTo: false,
                isUTP: false,
                peerIsChoked: peer.peerChoked,
                peerIsInterested: peer.peerInterested,
                port: 0,
                progress: 0,
                rateToClient: 0,
                rateToPeer: 0
            } for each (peer in this.swarm.peers)],
            peersConnected: Object.keys(this.swarm.peers).length,
            peersFrom: {
                fromCache: 0,
                fromDht: 0,
                fromIncoming: 0,
                fromLpd: 0,
                fromLtep: 0,
                fromPex: 0,
                fromTracker: Object.keys(this.swarm.peers).length
            },
            peersGettingFromUs: 0,
            peersSendingToUs: 0,
            percentDone: this.percentDone,
            pieces: base64.encode(this.swarm.getBitfield(this.store.pieces.length)),
            pieceCount: this.store.pieces.length,
            pieceSize: this.store.pieceLength,
            priorities: [file.priority for each (file in this.store.files)],
            queuePosition: 0,
            rateDownload: 0,
            rateUpload: 0,
            recheckProgress: 1.0,
            secondsDownloading: 0,
            secondsSeeding: 0,
            seedIdleLimit: 0,
            seedIdleMode: 0,
            seedRatioLimit: .0,
            seedRatioMode: 0,
            sizeWhenDone: this.sizeWhenDone,
            startDate: this.startDate,
            status: 4,
            trackers: [{
                announce: tracker.announce,
                id: tracker.id,
                scrape: tracker.scrape,
                tier: 0
            } for each (tracker in this.trackers.trackers)],
            trackerStats: [{
                announce: tracker.announce,
                announceState: 0,
                downloadCount: 0,
                hasAnnounced: false,
                hasScraped: false,
                host: tracker.url.host,
                id: tracker.id,
                isBackup: false,
                lastAnnouncePeerCount: 0,
                lastAnnounceResult: '',
                lastAnnounceStartTime: 0,
                lastAnnounceSucceeded: false,
                lastAnnounceTime: 0,
                lastAnnounceTimedOut: false,
                lastScrapeResult: '',
                lastScrapeStartTime: 0,
                lastScrapeSucceeded: false,
                lastScrapeTime: 0,
                lastScrapeTimedOut: false,
                leecherCount: 0,
                nextAnnounceTime: tracker.nextAnnounceTime,
                nextScrapeTime: tracker.nextScrapeTime,
                scrape: tracker.scrape,
                scrapeState: 0,
                seederCount: 0,
                tier: 0
            } for each (tracker in this.trackers.trackers)],
            totalSize: this.store.totalLength,
            torrentFile: '',
            uploadedEver: false,
            uploadLimit: 0,
            uploadLimited: false,
            uploadRatio: .0,
            wanted: [file.wanted for each (file in this.store.files)],
            webseeds: [],
            webseedsSendingToUs: 0
        };

        let result = {};
        for each (let field in fields) {
            if (data[field] === undefined) {
                this.error('unknown torrent-get field '+field);
            } else {
                result[field] = data[field];
            }
        }
        return result;
    },

    addPeerExtension: function(peer, extension) {
        if (extension === 'ut_metadata') {
            this.metadataPeers.push(peer);
        }
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
    
    enableFile: function(name) {
        this.store.getFile(name).wanted = true;
    },

    start: function(options) {
        this.state = 'started';
        this.startDate = Date.now();
        this.debug('started');
        this.store.inspect();
        this.trackers.start();
        this.mainLoop = timers.setInterval((function() {
            try {
                let pieces = this.getPiecesToRequest(options.progressive===false);
                this.requestPieces(pieces);
            } catch (e) {
                console.exception(e);
            }
        }).bind(this), 5000);
    },

    stop: function() {
        timers.clearInterval(this.mainLoop);
        this.state = 'stopped';
    },

    getPiecesToRequest: function(sortByAvailability) {
        this.debug('getPiecesToRequest sortByAvailability='+sortByAvailability);
 
        let piecesToRequest = [];
        let available = this.swarm.available;
        for each (let file in this.store.files) {
            if (!file.wanted) {
                continue;
            }
            this.debug('checking pieces for file '+file.name);
            for each (let piece in file.getNeededPieces()) {
                if (piece.index in available) {
                    this.debug('piece '+piece.index+' is needed and available');
                    piecesToRequest.push(piece);
                } else {
                    this.debug('piece '+piece.index+' is needed but unavailable');
                }
            }
 
            if (sortByAvailability) {
                piecesToRequest.sort(function(a, b) {
                    return available[a] - available[b]; //sort the pieces that I don't have by the number of people who have it
                });
                this.debug('pieces sorted by availability (rarest first). ('+piecesToRequest.length+') :'+piecesToRequest.join(', '));
            }
        }
        
       return piecesToRequest;
    },

    requestPieces: function(pieces) {
        for each (let piece in pieces.slice(0, 50)) {
            for (let start = 0; start < piece.length; start += fragmentSize) {
                this.swarm.requestPieceFragment(piece.index, start, ((start + fragmentSize) <= piece.length ? fragmentSize : (piece.length - start)));
            }
        }
    }
});

exports.Torrent = Torrent;

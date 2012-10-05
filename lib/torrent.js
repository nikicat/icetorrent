'use strict';

const bencode = require('bencode');
const {Store} = require('filestore');
const {fs} = require('io');
const {Listener} = require('listener');
const {Peer} = require('peer');
const traceback = require('traceback');
const timers = require('timers');
const http = require('http');
const settings = require('settings');
const {Logged, esc} = require('log');
const {Class} = require('heritage');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const {Request} = require("request");
const {TrackerManager} = require('./tracker');
const {Swarm, generatePeerId} = require('./swarm');
const {computeHash} = require('./util');
const {rpc} = require('./rpc');
const base64 = require('base64');

function dumpObj(obj) {
    for (let key in Object.keys(obj)) {
        console.debug('this.peers['+key+']='+obj[key]);
    }
}

const fragmentSize = Math.pow(2, 14);

const TorrentManager = Class({
    implements: [Logged, EventTarget],
    name: 'TorrentManager',
    initialize: function() {
        this.tag = this.name;
        this.torrents = {};
        this.listener = new Listener();
        this.listener.on('newpeer', this.onPeer.bind(this));
        this.listener.start();
        rpc.on('session-get', this.getSession.bind(this));
        rpc.on('session-stats', this.getSessionStats.bind(this));
        rpc.on('torrent-get', this.getTorrent.bind(this));
        rpc.on('port-test', this.portTest.bind(this));
    },
    onPeer: function(conn) {
        let peer = new Peer(conn);
        peer.on('handshake', (function () {
            let torrent = this.torrents[peer.infoHash];
            if (torrent === undefined) {
                peer.abort();
            } else {
                torrent.newPeer(peer);
            }
        }).bind(this));
    },
    register: function(torrent) {
        this.torrents[torrent.infoHash] = torrent;
        this.info('registerd new torrent '+torrent.tag);
        torrent.on('changed', emit.bind(null, this, 'changed'));
        emit(this, 'changed');
    },
    load: function(metadata, options) {
        var metainfo = bencode.decode(metadata);
        if ('comment' in metainfo) {
            this.info('comment: "' + metainfo.comment + '"');
        }
        let torrent = new Torrent(metainfo.info, options);
        this.register(torrent);
        return torrent;
    },
    getSession: function() {
        return {
            'alt-speed-down': 0,
            'alt-speed-enabled': false,
            'alt-speed-time-begin': 0,
            'alt-speed-time-enabled': false,
            'alt-speed-time-end': 0,
            'alt-speed-time-day': 0,
            'alt-speed-up': 0,
            'blocklist-url': '',
            'blocklist-enabled': false,
            'blocklist-size': 0,
            'cache-size-mb': 0,
            'config-dir': '',
            'download-dir': settings.destDir,
            'download-dir-free-space': -1,
            'download-queue-size': 0,
            'download-queue-enabled': false,
            'dht-enabled': false,
            'encryption': 'tolerated',
            'idle-seeding-limit': 0,
            'idle-seeding-limit-enabled': false,
            'lpd-enabled': false,
            'peer-limit-global': 0,
            'peer-limit-per-torrent': 0,
            'pex-enabled': false,
            'peer-port': this.listener.port,
            'peer-port-random-on-start': false,
            'port-forwarding-enabled': false,
            'queue-stalled-enabled': false,
            'queue-stalled-minutes': 0,
            'rename-partial-files': false,
            'rpc-version': 14,
            'rpc-version-minimum': 14,
            'script-torrent-done-filename': '',
            'script-torrent-done-enabled': false,
            'seedRatioLimit': .0,
            'seedRatioLimited': false,
            'seed-queue-size': 0,
            'seed-queue-enabled': false,
            'speed-limit-down': 0,
            'speed-limit-down-enabled': false,
            'speed-limit-up': 0,
            'speed-limit-up-enabled': false,
            'start-added-torrents': false,
            'trash-original-torrent-files': false,
            units: {
                'speed-units': ['KB/s', 'MB/s', 'GB/s', 'TB/s'],
                'speed-bytes': 1000,
                'size-units': ['KB', 'MB', 'GB', 'TB'],
                'size-bytes': 1024,
                'memory-units': ['KB', 'MB', 'GB', 'TB'],
                'memory-bytes': 1024
            },
            'utp-enabled': false,
            version: '1 (1)'
        };
    },
    getSessionStats: function() {
        return {
            activeTorrentCount: Object.keys(this.torrents).length,
            downloadSpeed: 0,
            pausedTorrentCount: 0,
            torrentCount: Object.keys(this.torrents).length,
            uploadSpeed: 0,
            'cumulative-stats': {
                uploadedBytes: 0,
                downloadedBytes: 0,
                filesAdded: 0,
                sessionCount: 0,
                secondsActive: 0
            },
            'current-stats': {
                uploadedBytes: 0,
                downloadedBytes: 0,
                filesAdded: 0,
                sessionCount: 0,
                secondsActive: 0
            }
        };
    },
    getTorrent: function(args) {
        let result = {
            torrents: [torrent.getFields(args.fields) for each (torrent in this.torrents) if (args.ids === undefined || args.ids === 'recently-active' || args.ids.indexOf(torrent.id) !== -1)]
        };
        if (arguments.ids === 'recently-active') {
            // TODO: add removed torrent ids
            result.removed = [];
        }
        return result;
    },
    portTest: function() {
        return {'port-is-open': false};
    }
});

exports.TorrentManager = TorrentManager;
exports.torrents = new TorrentManager();

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

        this.peerId = options.peerId || generatePeerId();
        this.addedDate = Date.now();
        this.activityDate = Date.now();

        this.swarm = options.swarm || new Swarm({
            peerId: this.peerId,
            infoHash: this.infoHash
        });

        this.downloadedEver = 0;
        this.haveValid = 0;
        this.corruptEver = 0;
        this.haveUnchecked = 0;

        this.store = new Store(info);
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

        this.trackers = options.trackers || new TrackerManager({
            port: this.listener.port,
            peerId: this.peerId,
            infoHash: this.infoHash,
            announce: options.announce,
            announceList: options['announce-list']
        });
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
            comment: '',
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
        this._state = 'started';
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

const {Logged, esc} = require('./log');
const {Class} = require('heritage');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const {Listener} = require('listener');
const {TrackerManager} = require('./tracker');
const {Stats} = require('./fs');
const {Peer} = require('./peer');
const {Swarm, generatePeerId} = require('./swarm');
const settings = require('simple-prefs').prefs;
const file = require('file');
const rpc = require('./rpc');

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
        rpc.on('torrent-stop', this.stopTorrent.bind(this));
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
    load: function(metadata) {
        let metainfo = bencode.decode(metadata);
        if ('comment' in metainfo) {
            this.info('comment: "' + metainfo.comment + '"');
        }
        let infoHash = computeHash(metainfo.info);
        let torrent = this.torrents[infoHash];
        if (torrent === undefined) {
            let peerId = generatePeerId();
            let trackerManager = TrackerManager({
                infoHash: infoHash,
                port: this.listener.port,
                peerId: peerId,
                announce: metainfo.announce,
                announceList: metainfo['announce-list']
            });
            let swarm = Swarm({
                infoHash: infoHash,
                peerId: peerId
            });
            this.torrents[infoHash] = torrent = Torrent(metainfo.info, {
                trackerManager: trackerManager,
                swarm: swarm,
                comment: metainfo.comment
            });
            let file = Stats(settings.torrentsDir, torrent.name);
            if (!file.exists) {
                file.open('w+').write(metadata);
            }
        }
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
            'download-dir': settings.downloadDir,
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
    stopTorrent: function (args) {
        for each (let torrent in this.torrents) {
            if (args.ids.length === 0 || args.ids.indexOf(torrent.id) !== -1) {
                torrent.stop();
            }
        }
    },
    portTest: function () {
        return {'port-is-open': false};
    },
    loadTorrents: function () {
        let dir = Stats(settings.torrentsDir);
        if (dir.exists && !dir.isDirectory) {
            dir.unlink();
        }
        if (!dir.exists) {
            dir.mkdir();
        }
        for each (let file in dir.list()) {
            this.load(file.open().read());
        }
    }
});

exports.TorrentManager = TorrentManager();
exports.TorrentManager.loadTorrents();

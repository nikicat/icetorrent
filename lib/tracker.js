const url = require('url2');
require('udpproto'); // Just to register url scheme handler
const {UdpTracker} = require('udptracker');
const {HttpTracker} = require('httptracker');
const {Class} = require('heritage');
const {Logged} = require('log');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const timers = require('timers');

'use strict';

function createTracker(url) {
    if (url.scheme == 'http' || url.scheme == 'https') {
        return HttpTracker(url);
    } else if (url.scheme == 'udp') {
        return UdpTracker(url);
    } else {
        throw new Error('unsupported tracker protocol: '+url.scheme);
    }
}

const TrackerManager = Class({
    implements: [Logged, EventTarget],
    initialize: function(options) {
        this.infoHash = options.infoHash;
        this.peerId = options.peerId;
        this.port = options.port || 0;
        var parsedUrl = url.URL(options.announce);
        console.debug("parsed announce ("+options.announce+"): scheme="+parsedUrl.scheme+" hostname="+parsedUrl.host+" port="+parsedUrl.port+" pathname="+parsedUrl.path);
        this.trackers = [createTracker(parsedUrl)];
        for each (list in (options.announceList || [])) {
            for each (announce in list) {
                var parsedUrl = url.URL(announce);
                console.debug("parsed announce-list item ("+announce+"): scheme="+parsedUrl.scheme+" hostname="+parsedUrl.host+" port="+parsedUrl.port+" pathname="+parsedUrl.path);
                this.trackers.push(createTracker(parsedUrl));
            }
        }
    },

    pingTracker: function(trackerClient) {
        var params = {
            info_hash: this.infoHash,
            peer_id: this.peerId,
            port: this.port,
            uploaded: 0,
            downloaded: 0,
            numwant: 50,
            left: this.store ? this.store.left : 0,
            compact: 1,
            event: 'started'
        };
        trackerClient.ping(params, (function(error, response) {
            if (!error) {
                var interval = response.interval;
                if ('peers' in response) {
                    var newPeers = response.peers;
                    var numPeers = newPeers.length / 6;
                    this.info('tracker gave us ' + numPeers + ' ipv4 peers.');
                    for (var i = 0; i < numPeers; i++) {
                        emit(this, 'peeraddress', newPeers.substring(i * 6, (i + 1) * 6));
                    }
                }
                if ('peers6' in response) {
                    var newPeers = response.peers6;
                    var numPeers = newPeers.length / 18;
                    this.info('tracker gave us ' + numPeers + ' ipv6 peers.');
                    for (var i = 0; i < numPeers; i++) {
                        emit(this, 'peeraddress', newPeers.substring(i * 18, (i + 1) * 18));
                    }
                }
            } else {
                this.error('tracker returned error: '+error);
                console.exception(error);
                var interval = 20*60;
            }
            this.pingTimer = timers.setTimeout(this.pingTracker.bind(this, trackerClient), interval * 1000);
        }).bind(this));
    },

    start: function() {
        for each (client in this.trackers) {
            this.pingTracker(client);
        }
    }
});

exports.TrackerManager = TrackerManager;

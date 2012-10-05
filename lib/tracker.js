const url = require('url2');
require('udpproto'); // Just to register url scheme handler
const {UdpTracker} = require('udptracker');
const {HttpTracker} = require('httptracker');
const {Class} = require('heritage');
const {Logged} = require('log');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const timers = require('timers');
const base64 = require('base64');

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
        this.tag = base64.encode(this.infoHash.slice(0,5));
        var parsedUrl = url.URL(options.announce);
        this.debug("parsed announce ("+options.announce+"): scheme="+parsedUrl.scheme+" hostname="+parsedUrl.host+" port="+parsedUrl.port+" pathname="+parsedUrl.path);
        this.trackers = [createTracker(parsedUrl)];
        for each (list in (options.announceList || [])) {
            for each (announce in list) {
                let parsedUrl = url.URL(announce);
                this.debug("parsed announce-list item ("+announce+"): scheme="+parsedUrl.scheme+" hostname="+parsedUrl.host+" port="+parsedUrl.port+" pathname="+parsedUrl.path);
                let tracker = createTracker(parsedUrl);
                tracker.id = this.trackers.length;
                this.trackers.push(tracker);
            }
        }
    },

    pingTracker: function(trackerClient) {
        let params = {
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
            let interval;
            if (!error) {
                interval = response.interval;
                if ('peers' in response) {
                    let num = response.peers.length / 6;
                    this.info('tracker gave us ' + num + ' ipv4 peers');
                    for (let i = 0; i < num; i++) {
                        emit(this, 'peeraddress', response.peers.substring(i * 6, (i + 1) * 6));
                    }
                }
                if ('peers6' in response) {
                    let num = response.peers6.length / 18;
                    this.info('tracker gave us ' + num + ' ipv6 peers');
                    for (let i = 0; i < num; i++) {
                        emit(this, 'peeraddress', response.peers6.substring(i * 18, (i + 1) * 18));
                    }
                }
            } else {
                this.error('tracker returned error: '+error);
                console.exception(error);
                interval = 20*60;
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

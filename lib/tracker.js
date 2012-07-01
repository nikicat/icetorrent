var url = require('url2');
require('udpproto'); // Just to register url scheme handler
var { UdpTracker } = require('udptracker');
var { HttpTracker } = require('httptracker');

'use strict';

function createTrackers(announce, announceList=[]){
    var parsedUrl = url.URL(announce);
    console.debug("parsed announce ("+announce+"): scheme="+parsedUrl.scheme+" hostname="+parsedUrl.host+" port="+parsedUrl.port+" pathname="+parsedUrl.path);
    var trackers = [createTracker(parsedUrl)];
    for (i in announceList) {
        for (j in announceList[i]) {
            var parsedUrl = url.URL(announceList[i][j]);
            console.debug("parsed announce-list item ("+announceList[i][j]+"): scheme="+parsedUrl.scheme+" hostname="+parsedUrl.host+" port="+parsedUrl.port+" pathname="+parsedUrl.path);
            trackers.push(createTracker(parsedUrl));
        }
    }
    return trackers;
}

function createTracker(url) {
    if (url.scheme == 'http' || url.scheme == 'https') {
        return HttpTracker(url);
    } else if (url.scheme == 'udp') {
        return UdpTracker(url);
    } else {
        throw new Error('unsupported tracker protocol: '+url.scheme);
    }
}

exports.createTrackers = createTrackers;

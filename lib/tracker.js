var url = require('url2');
require('udpproto'); // Just to register url scheme handler
var { UdpTracker } = require('udptracker');
var { HttpTracker } = require('httptracker');

function create(metaInfo){
    var announce = metaInfo.announce;
    var announcelist = metaInfo['announce-list'];
    var parsedUrl = url.URL(announce);
    console.debug("parsed announce ("+announce+"): scheme="+parsedUrl.scheme+" hostname="+parsedUrl.host+" port="+parsedUrl.port+" pathname="+parsedUrl.path);
    var trackers = [createTracker(parsedUrl)];
    for (i in announcelist) {
        for (j in announcelist[i]) {
            var parsedUrl = url.URL(announcelist[i][j]);
            console.debug("parsed announce-list item ("+announcelist[i][j]+"): scheme="+parsedUrl.scheme+" hostname="+parsedUrl.host+" port="+parsedUrl.port+" pathname="+parsedUrl.path);
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

exports.create = create;

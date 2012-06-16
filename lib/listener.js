var net = require('net');
var { Peer } = require('./peer');


function create(port, torrent){
    var state = 0;
    var server = new net.Server(function(stream){
        console.log('createServer callback from '+stream.remoteAddress);
        var peerAddress = [0,0,0,0].map(function(){return Math.floor(Math.random()*255)}).join('.')+':'+Math.floor(6881 + Math.random()*100);
        torrent.peers[peerAddress] = new Peer(peerAddress, null, null, torrent, stream);
    });
    server.listen(port);
}

exports.create = create;

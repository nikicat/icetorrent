//console.debug('onopen');
document.body.onload = function () {
    console.debug('onload');
}
    document.newtorrent.onsubmit = function(){
        console.debug('newtorrent');
        self.postMessage({type: "newtorrent", uri: document.newtorrent.uri.value});
        return false;
    };
//};

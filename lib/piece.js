const {Logged} = require('./log');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const cryptolib = require('./crypto');
const {Class} = require('heritage');
const fs = require('./fs');
const timers = require('timers');

function toHexString(charCode) {  
    return ("0" + charCode.toString(16)).slice(-2);  
}

function hashToHexString(hash) {
    return [toHexString(hash.charCodeAt(i)) for (i in hash)].join("");
}

// Makes sure all the directories exist for a given path.
// If they don't exist, tries to create them.
// Calls callback(err)
function ensureDirExists(fullPath, callback) {
    var mode = 7 * 64 + 7 * 8 + 7; // 0777 aka rwxrwxrwx-
    var parts = fullPath.split('/'), root;
    if (parts.length > 1) {
        parts.pop();
        if (fullPath.charAt(0) == '/') {
            root = '';
        } else {
            root = '.';
        }
        ensureDirExists2(root, parts, callback);
    } else {
        callback(null);
    }
    function ensureDirExists2(base, dirList, callback){
        var newPath = base + '/' + dirList.shift();
        fs.stat(newPath, function(err, stats){
            if (err) {
                makeDir();
            } else if (!stats.isDirectory()) {
                fs.unlink(newPath, function(err){
                    if (err) {
                        callback(err);
                    } else {
                        makeDir();
                    }
                });
            } else {
                checkKids();
            }
        });
        function makeDir(){
            fs.mkdir(newPath, mode, checkKids);
        }
        function checkKids(err){
            if (err || dirList.length == 0) {
                callback(err);
            } else {
                ensureDirExists2(newPath, dirList, callback);
            }
        }
    }
}

function ensureFile2(file, callback) {
    var mode = 6 * 64 + 4 * 8 + 4; // 0666 aka rw-rw-rw-
    fs.stat(file.path, function(err, stats) {
        if (err) {
            fs.open(file.path, 'w', mode, function(error, fd){
                if (error) {
                    callback(error, file);
                } else {
                    fs.truncate(fd, file.length, function(error){
                        if (error) {
                            callback(error, file);
                        } else {
                            // Need to close this descriptor and try again.
                            fs.close(fd, function(error){
                                if (error) {
                                    callback(error, file);
                                } else {
                                    ensureFile2(file, callback);
                                }
                            });
                        }
                    });
                }
            });
        } else if (stats.isDirectory() || stats.size !== file.length) {
            fs.unlink(file.path, function(error){
                if (error) {
                    callback(error, file);
                } else {
                    ensureFile2(file, callback);
                }
            });
        } else {
            // file exists, and is right length and type
            fs.open(file.path, 'r+', mode, function(error, fd){
                if (error) {
                    callback(error, file);
                } else {
                    file.fd = fd;
                    callback(error, file);
                }
            });
        }
    });
}

//Calls callback(err, file)
function ensureFile(file, callback) {
    if (file.fd) {
        callback(null, file);
    } else {
        ensureDirExists(file.path, function(err) {
            if (err) {
                callback(err, file);
            } else {
                ensureFile2(file, callback);
            }
        });
    }
}

const Piece = Class({
    implements: [Logged, EventTarget],
    name: 'Piece',
    initialize: function(store, index, hash, length) {
        this.store = store;
        this.index = index;
        this.hash = hash;
        this.good = false;
        this.tag = index;
        this.length = length;
        this.offset = index * store.pieceLength;
        this.downloading = {};
    },

    inspect: function(callback){
        let hash = new cryptolib.Hash('sha1');
        this.readPiece((function(error, data) {
            if (error) {
                return callback(error);
            }

            if (data) {
                hash.update(data);
            } else {
                let digest = hash.digest('binary');
                this.debug('digest: '+hashToHexString(digest)+" expected: "+hashToHexString(this.hash));
                this.good = this.hash === digest;
                
                callback(this.good ? null : Error('hash mismatch'));
            }
        }).bind(this));
    },

    // Callback called repeatedly with args (error, data)
    // data will be null after all fragments have been read.
    readPiecePart: function(begin, length, callback){
        let iterator = this.createFragmentIterator(begin, length);
        function readPieceImp() {
            if (iterator.hasNext()) {
                let fragment = iterator.next();
                ensureFile(fragment.file, function(error, file){
                    if (error) {
                        callback(error);
                    } else {
                        fs.read(file.fd, fragment.length, fragment.offset, 'binary', function(err, data){
                            callback(err, data);
                            if (!err) {
                                timers.setTimeout(readPieceImp, 0);
                            }
                        });
                    }
                });
            } else {
                callback(null, null);
            }
        }
        readPieceImp();
    },

    readPiece: function(callback){
        this.readPiecePart(0, this.length, callback);
    },
 
    addFragment: function(offset, data) {
        let length = data.length;
        if (!((offset >= 0 && offset + length <= this.length) &&
            (length > 0 && length <= 32 * 1024))) {
            this.error('could not add piece fragment: offset='+offset+' length='+length);
            throw new Error('bad piece fragment');
        }
        this.debug('received piece fragment '+offset+' '+length);
        
        this.downloading[offset] = true;

        /*if (this.pieces[index] === undefined) {
            this.pieces[index] = new Uint8Array(pieceLength);
        }

        let piece = this.pieces[index];
        piece.set(data, offset);

        return;*/

        this.writePiecePart(offset, data, (function(err) {
            if (err) {
                this.warn('fragment writing failed', err);
                return;
            }
            this.debug('wrote fragment ['+offset+';'+(offset+data.length)+']'); // Reduced verbosity.
            
            let hasdone = 0;                
            for (let z in this.downloading)
                hasdone += +this.downloading[z];
           
            // HACK: this condition may be false-positive
            if (hasdone === Math.ceil(this.length/data.length)){
                this.inspect((function(error) {
                    if (!error) {
                        this.info('finished');
                        emit(this.store, 'havepiece', this);
                    } else {
                        this.warn('broken piece: '+error);
                        emit(this.store, 'corruptpiece', this);
                    }
                }).bind(this))
            } else {
                this.debug('not done yet')
            }
        }).bind(this));
    },

    //Callback (error)
    writePiecePart: function(offset, data, callback){
        let iterator = this.createFragmentIterator(offset, data.length);
        function writePieceImp(){
            var fragment;
            if (iterator.hasNext()) {
                fragment = iterator.next();
                ensureFile(fragment.file, function(error, file){
                    var dataFrag;
                    if (error) {
                        callback(error);
                    } else {
                        dataFrag = data.substring(0, fragment.length);
                        data = data.substring(fragment.length);
                        fs.write(file.fd, dataFrag, fragment.offset, 'binary', function(err, bytesWritten){
                            if (err) {
                                callback(err);
                            } else {
                                writePieceImp();
                            }
                        });
                    }
                });
            } else {
                callback(null);
            }
        }
        writePieceImp();
    },

    // begin and length are optional arguments.
    createFragmentIterator: function(offset, length){
        let offset = this.offset + offset;
        return this.store.createRangeIterator(offset, length);
    }
});

exports.Piece = Piece;

#!/bin/bash
set -m
cmd="cfx run -p profile --package-path=/usr/lib/node_modules/ -b /usr/bin/firefox-nightly $@"
if [ "$1" = '-v' ]; then
    NSPR_LOG_MODULES=all:5 $cmd >output.log 2>&1 &
else
    $cmd >output.log 2>&1 &
fi
pid=$!
less output.log
kill -INT $pid

#!/bin/bash
CWD=`CPWD=$(pwd);cd $(dirname $0);pwd;cd $CPWD`
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
cd $CWD
nvm use
pm2 start ecosystem.config.js

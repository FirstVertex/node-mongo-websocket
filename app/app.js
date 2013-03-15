// helper functions

var sysUtil = require('util');

function logMessage(msg) {
    console.log((new Date()) + ' > ' + msg);
}

function fatalError(err) {
    if (err) {
        logMessage("*** Fatal Error " + err);
        throw (err);
    }
}

function inspectObject(obj) {
    return sysUtil.inspect(obj, true, 3, true);
}


// setup dbserver

var mongo = require('mongodb'),
    dbName = "smartjs-db",
    dbHost = process.env['DOTCLOUD_DB_MONGODB_HOST'] || 'localhost',
    dbPort = parseInt(process.env['DOTCLOUD_DB_MONGODB_PORT'] || 27017),
    dbUser = process.env['DB_MONGODB_LOGIN'] || undefined,
    dbPass = process.env['DB_MONGODB_PASSWORD'] || undefined,
    mongoServer = new mongo.Server(dbHost, dbPort, {}),
    db = new mongo.Db(dbName, mongoServer, { auto_reconnect: true, w: 'majority' }),
    chatLogTable;

// init
db.open(function (err) {
    fatalError(err);

    if (dbUser && dbPass) {
        logMessage('auth to mongo with user=' + dbUser + ',pass=' + dbPass);
        db.authenticate(dbUser, dbPass, fatalError);
    }

    db.collection("chatLog", function (err2, collection) {
        fatalError(err2);
        chatLogTable = collection;
    });
});

// api
function logChat(message) {
    chatLogTable.insert({ message: message }, { w: 0 });
}

function getLastChat(callback) {
    chatLogTable.find().sort({ $natural: -1 }).limit(10).toArray(function (err, docs) {
        fatalError(err);
        callback(docs.reverse());
    });
}


// setup webserver

var express = require('express'),
    app = express(),
    http = require('http'),
    path = require('path'),
    secret = 'A354673E-1060-408E-BA6D-22B3BBE46AFC',
    cookieParser = express.cookieParser(secret),
    httpServer,
    listenPort = 8080;

app.configure(function () {
    app.use(cookieParser);
    app.use(express.bodyParser());
    app.use(express.static(path.join(__dirname, 'public')));
    app.use(app.router);
});

app.configure('development', function () {
    app.use(express.errorHandler({
        dumpExceptions: true,
        showStack: true
    }));
});

httpServer = http.createServer(app);
// begin listening
httpServer.listen(listenPort);


// setup socketserver

var WorlizeWebSocketServer = require('websocket').server,
    socketServer = new WorlizeWebSocketServer({
        // pass reference to already created httpServer
        httpServer: httpServer,
        // this should always be set to false
        autoAcceptConnections: false
    }),
    url = require('url'),
    requestFilter,
    allConnections = {},
    connectionIdCounter = 1;

function sameOriginCheck(request) {
    var originUrl = url.parse(request.origin);
    // check to make sure the file was served by me (from ./public)
    return originUrl.hostname === request.host;
}

// by default, only allow requests served by me
requestFilter = sameOriginCheck;

function alwaysAllow() {
    return true;
}

app.configure('development', function () {
    // allow connections from anybody if dev
    requestFilter = alwaysAllow;
});

socketServer.on('request', socketRequestHandler);

function socketRequestHandler(request) {
    logMessage('Connection from origin ' + request.origin + ' received.');
    // use requestFilter, whatever it may be
    if (!requestFilter(request)) {
        request.reject();
        logMessage('*** Rejected Connection from origin ' + request.origin);
        return;
    }

    var connection = request.accept('echo-protocol', request.origin);

    connection.id = connectionIdCounter++;
    logMessage('Connection number ' + connection.id + ' accepted.');

    allConnections[connection.id] = connection;
    
    // welcome the connected user
    connection.sendUTF("Welcome echo user @" + request.remoteAddress);

    // handle data on the socket
    connection.on('message', function (message) {
        if (message.type === 'utf8') {
            logMessage('Received Message: ' + message.utf8Data);
            logChat(message.utf8Data);
            broadcast(message.utf8Data);
        }
        //else if (message.type === 'binary') {
        //    logMessage('Received Binary Message of ' + message.binaryData.length + ' bytes');
        //    logChat('[a binary message]');
        //    broadcast(message.binaryData);
        //}
    });

    connection.on('close', function (reasonCode, description) {
        logMessage('Connection ' + connection.remoteAddress + ' disconnected because ' + description);

        allConnections[connection.id] = null;
        delete allConnections[connection.id];
    });

    // send the last 10 messages upon connect
    getLastChat(function (lastChat) {
        if (lastChat) {
            for (var i = 0; i < lastChat.length; i++) {
                connection.sendUTF(lastChat[i].message);
            }
        }
    });
}

// taken from https://github.com/Worlize/WebSocket-Node/wiki/How-to:-List-all-connected-sessions-&-Communicating-with-a-specific-session-only
// Broadcast to all open connections
function broadcast(data) {
    Object.keys(allConnections).forEach(function (key) {
        var connection = allConnections[key];
        if (connection.connected) {
            connection.send(data);
        }
    });
}

// Send a message to a connection by its connectionID
function sendToConnectionId(connectionID, data) {
    var connection = allConnections[connectionID];
    if (connection && connection.connected) {
        connection.send(data);
    }
}
var async = require('async');
var loopback = require('../');
var debug = require('debug')('test');
var supertest = require('supertest');

describe('Replication over REST', function() {
  var ALICE = { username: 'alice', email: 'a@example.com', password: 'p' };
  var PETER = { username: 'peter', email: 'p@example.com', password: 'p' };

  var MODEL_PROPS = {
    id: { type: 'string', id: true, defaultFn: 'guid' },
    fullname: { type: 'string' }
  };

  var MODEL_OPTS = {
    base: 'User',
    plural: 'Users', // use the same REST path in all models
    trackChanges: true,
    strict: true,
    persistUndefinedAsNull: true
  };

  var serverApp, ServerUser, aliceId, peterId, request;
  var clientApp, LocalUser, RemoteUser;

  before(setupServer);
  before(setupClient);
  beforeEach(seedServerData);

  it('is correctly set up', function(done) {
    // A smoke test to verify that we have correctly setup
    // the server, the remoting connector and authentication
    RemoteUser.login(ALICE, function(err, token) {
      if (err) return done(err);
      setAccessToken(token.id);
      RemoteUser.findById(aliceId, function(err, alice) {
        if (err) return done(err);
        expect(alice).to.have.property('email', alice.email);

        RemoteUser.findById(peterId, function(err, peter) {
          if (!err)
            return done(new Error('findById(peterId) should have failed'));

          expect(err.statusCode).to.equal(401); // not authorized
          done();
        });
      });
    });
  });

  it('pulls only authorized records', function(done) {
    // TODO(bajtos) Perhaps we should setup up replication filter
    // to allow only authorized records?
    RemoteUser.login(ALICE, function(err, token) {
      if (err) return done(err);
      setAccessToken(token.id);

      RemoteUser.replicate(LocalUser, function(err, conflicts, cps) {
        if (err) return done(err);
        if (conflicts.length) return done(ConflictError(conflicts));
        LocalUser.find(function(err, users) {
          var userNames = users.map(function(u) { return u.username; });
          expect(userNames).to.eql([ALICE.username]);
          done();
        });
      });
    });
  });

  it('pushes authorized records', function(done) {
    async.series([
      // Replicate directly, bypassing REST+AUTH layers
      replicateServerToLocal,
      function setupLocalCopy(next) {
        LocalUser.updateAll(
          { id: aliceId },
          { fullname: 'Alice Smith' },
          next);
      },

      function loginAndReplicate(next) {
        RemoteUser.login(ALICE, function(err, token) {
          if (err) return next(err);
          setAccessToken(token.id);

          LocalUser.replicate(RemoteUser, function(err, conflicts) {
            if (err) return next(err);
            if (conflicts.length) return next(ConflictError(conflicts));
            next();
          });
        });
      },

      function verify(next) {
        RemoteUser.findById(aliceId, function(err, found) {
          if (err) return next(err);
          expect(found.toObject()).to.have.property('fullname', 'Alice Smith');
          next();
        });
      }
    ], done);
  });

  it('rejects push containing unauthorized records', function(done) {
    async.series([
      // Replicate directly, bypassing REST+AUTH layers
      replicateServerToLocal,
      function setupLocalCopy(next) {
        LocalUser.updateAll(
          { id: aliceId },
          { fullname: 'Alice Smith' },
          next);
      },

      function loginAndReplicateAsDifferentUser(next) {
        RemoteUser.login(PETER, function(err, token) {
          if (err) return next(err);
          setAccessToken(token.id);

          LocalUser.replicate(RemoteUser, function(err, conflicts) {
            if (!err)
              return next(new Error('Replicate should have failed.'));
            expect(err).to.have.property('statusCode', 401); // or 403?
            next();
          });
        });
      },

      function verify(next) {
        RemoteUser.findById(aliceId, function(err, found) {
          if (err) return next(err);
          expect(found.toObject()).to.have.property('fullname', 'Alice Smith');
          next();
        });
      }
    ], done);
  });

  function setupServer(done) {
    serverApp = loopback();
    serverApp.enableAuth();

    serverApp.dataSource('db', { connector: 'memory' });

    // Setup a custom access-token model that is not shared
    // with the client app
    var ServerToken = loopback.createModel('ServerToken', {}, {
      base: 'AccessToken',
      relations: {
        user: {
          type: 'belongsTo',
          model: 'User',
          foreignKey: "userId"
        }
      }
    });
    serverApp.model(ServerToken, { dataSource: 'db', public: false });

    ServerUser = loopback.createModel('ServerUser', MODEL_PROPS, MODEL_OPTS);
    serverApp.model(ServerUser, {
      dataSource: 'db',
      public: true,
      relations: { accessTokens: { model: 'ServerToken' } }
    });

    serverApp.use(loopback.token({ model: ServerToken } ));
    serverApp.use(loopback.rest());

    serverApp.set('legacyExplorer', false);
    serverApp.set('port', 0);
    serverApp.set('host', '127.0.0.1');
    serverApp.listen(function() {
      request = supertest(serverApp.get('url'));
      done();
    });
  }

  function setupClient() {
    clientApp = loopback();
    clientApp.dataSource('db', { connector: 'memory' });
    clientApp.dataSource('remote', {
      connector: 'remote',
      url: serverApp.get('url').replace(/\/+$/, '')
    });

    LocalUser = loopback.createModel('LocalUser', MODEL_PROPS, MODEL_OPTS);

    // NOTE(bajtos) At the moment, all models share the same Checkpoint
    // model. This causes the in-process replication to work differently
    // than client-server replication.
    // As a workaround, we manually setup unique Checkpoint for ClientModel.
    var LocalChange = LocalUser.Change;
    LocalChange.Checkpoint = loopback.Checkpoint.extend('ClientCheckpoint');
    LocalChange.Checkpoint.attachTo(clientApp.dataSources.db);

    clientApp.model(LocalUser, { dataSource: 'db' });

    RemoteUser = loopback.createModel('RemoteUser', MODEL_PROPS, MODEL_OPTS);
    RemoteUser.Change.Checkpoint = LocalUser.Change.Checkpoint;
    clientApp.model(RemoteUser, { dataSource: 'remote' });
  }

  function seedServerData(done) {
    serverApp.dataSources.db.automigrate(function(err) {
      if (err) return done(err);
      ServerUser.deleteAll(function(err) {
        if (err) return done(err);

        ServerUser.create([ALICE, PETER], function(err, created) {
          if (err) return done(err);
          aliceId = created[0].id;
          peterId = created[1].id;

          LocalUser.deleteAll(done);
        });
      });
    });
  }

  function setAccessToken(token) {
    clientApp.dataSources.remote.connector.remotes.auth = {
      bearer: new Buffer(token).toString('base64'),
      sendImmediately: true
    };
  }

  function replicateServerToLocal(next) {
    ServerUser.replicate(LocalUser, function(err, conflicts) {
      if (err) return next(err);
      if (conflicts.length) return next(ConflictError(conflicts));
      next();
    });
  }

  function ConflictError(conflicts) {
    var err = new Error('Unexpected conflicts\n' +
      conflicts.map(JSON.stringify).join('\n'));
    err.name = 'ConflictError';
  }
});

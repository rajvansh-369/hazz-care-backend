/* ---------------------------------------------------------------------------
   API smoke console
   Drives the whole API from the browser: every call goes to this page's own
   origin, so a green run proves the gateway, the proxy, the service, the auth
   layer and MongoDB are all wired together correctly.
--------------------------------------------------------------------------- */
(function () {
  'use strict';

  var API = '/api/v1';

  var state = {
    email: null,
    password: 'Str0ng!Pass1',
    accessToken: null,
    refreshToken: null,
    user: null,
    taskId: null,
    running: false,
  };

  var $ = function (id) {
    return document.getElementById(id);
  };

  /* --- HTTP ------------------------------------------------------------- */

  /**
   * One place where every request is made, timed and recorded.
   * @returns {Promise<{status:number, ok:boolean, body:*, ms:number}>}
   */
  function call(method, path, options) {
    var settings = options || {};
    var headers = { Accept: 'application/json' };
    if (settings.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (settings.token) {
      headers.Authorization = 'Bearer ' + settings.token;
    }

    var startedAt = performance.now();
    return fetch(path, {
      method: method,
      headers: headers,
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
    })
      .then(function (response) {
        var contentType = response.headers.get('content-type') || '';
        var parse =
          contentType.indexOf('application/json') !== -1 ? response.json() : response.text();
        return parse
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return {
              status: response.status,
              ok: response.ok,
              body: body,
              ms: Math.round(performance.now() - startedAt),
            };
          });
      })
      .catch(function (error) {
        return {
          status: 0,
          ok: false,
          body: { message: 'Request never reached the server: ' + error.message },
          ms: Math.round(performance.now() - startedAt),
        };
      });
  }

  /* --- Uplink strip ------------------------------------------------------ */

  function setDot(dotId, textId, up, label) {
    var dot = $(dotId);
    dot.className = 'dot ' + (up === null ? 'dot--idle' : up ? 'dot--up' : 'dot--down');
    $(textId).textContent = label;
  }

  function refreshUplink() {
    return call('GET', '/gateway/health/services').then(function (result) {
      var reachable = result.status !== 0;
      setDot('dot-gateway', 'state-gateway', reachable, reachable ? 'up' : 'unreachable');

      var services = (result.body && result.body.data && result.body.data.services) || [];
      var core = services[0];
      var coreUp = !!core && core.status === 'up';
      setDot('dot-core', 'state-core', core ? coreUp : null, core ? core.status : 'unknown');

      if (!coreUp) {
        setDot('dot-db', 'state-db', null, 'unknown');
        return;
      }
      return call('GET', API + '/health/ready').then(function (ready) {
        var dependencies = (ready.body && ready.body.data && ready.body.data.dependencies) || {};
        var dbUp = dependencies.mongodb === 'up';
        setDot('dot-db', 'state-db', dbUp, dependencies.mongodb || 'unknown');
      });
    });
  }

  /* --- Session panel ----------------------------------------------------- */

  function shorten(token) {
    if (!token) {
      return '\u2014';
    }
    return token.slice(0, 18) + '\u2026' + token.slice(-8);
  }

  function renderSession() {
    $('session-user').textContent = state.user ? state.user.email : 'nobody';
    $('session-role').textContent = state.user ? state.user.role : '\u2014';
    $('session-access').textContent = shorten(state.accessToken);
    $('session-refresh').textContent = shorten(state.refreshToken);
  }

  function adoptSession(body) {
    if (!body || !body.data) {
      return;
    }
    if (body.data.tokens) {
      state.accessToken = body.data.tokens.access.token;
      state.refreshToken = body.data.tokens.refresh.token;
    }
    if (body.data.user) {
      state.user = body.data.user;
    }
    renderSession();
  }

  function clearSession() {
    state.accessToken = null;
    state.refreshToken = null;
    state.user = null;
    state.taskId = null;
    renderSession();
  }

  /* --- Rail rendering ---------------------------------------------------- */

  var rail = $('rail');

  function addStep(step, index) {
    var item = document.createElement('li');
    item.className = 'step';
    item.id = 'step-' + index;

    var head = document.createElement('button');
    head.className = 'step__head';
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');

    var method = document.createElement('span');
    method.className = 'step__method';
    method.textContent = step.method;

    var path = document.createElement('span');
    path.className = 'step__path';
    path.textContent = step.path;

    var meta = document.createElement('span');
    meta.className = 'step__meta';

    var latency = document.createElement('span');
    latency.className = 'step__latency';
    latency.textContent = '';

    var chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = 'queued';

    var label = document.createElement('span');
    label.className = 'step__label';
    label.textContent = step.label;

    meta.appendChild(latency);
    meta.appendChild(chip);
    head.appendChild(method);
    head.appendChild(path);
    head.appendChild(meta);
    head.appendChild(label);

    var body = document.createElement('div');
    body.className = 'step__body step__body--hidden';

    head.addEventListener('click', function () {
      var hidden = body.classList.toggle('step__body--hidden');
      head.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    });

    item.appendChild(head);
    item.appendChild(body);
    rail.appendChild(item);

    return { item: item, chip: chip, latency: latency, body: body, path: path };
  }

  function renderDetail(node, step, result) {
    var parts = [];
    parts.push('<b>Expected</b>' + escapeHtml(step.expectation));
    if (step.request !== undefined) {
      parts.push('<b>Request body</b>' + escapeHtml(JSON.stringify(step.request, null, 2)));
    }
    parts.push(
      '<b>Response ' + result.status + '</b>' + escapeHtml(JSON.stringify(result.body, null, 2))
    );
    node.innerHTML = parts.join('');
  }

  function escapeHtml(value) {
    return String(value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* --- The sequence ------------------------------------------------------ */

  function buildSteps() {
    var email = 'console+' + Date.now() + '@example.com';
    state.email = email;

    return [
      {
        method: 'GET',
        path: '/gateway/health/services',
        label: 'The gateway can reach the core service.',
        expectation: '200 with every upstream reporting "up"',
        run: function () {
          return call('GET', '/gateway/health/services');
        },
        check: function (r) {
          return r.status === 200;
        },
      },
      {
        method: 'GET',
        path: API + '/health/ready',
        label: 'The service is connected to MongoDB.',
        expectation: '200 with dependencies.mongodb = "up"',
        run: function () {
          return call('GET', API + '/health/ready');
        },
        check: function (r) {
          return r.status === 200 && r.body.data.dependencies.mongodb === 'up';
        },
      },
      {
        method: 'POST',
        path: API + '/auth/register',
        label: 'A new account is created and a token pair issued.',
        expectation: '201 with a user and both tokens',
        request: { name: 'Ada Lovelace', email: email, password: state.password },
        run: function () {
          return call('POST', API + '/auth/register', {
            body: { name: 'Ada Lovelace', email: email, password: state.password },
          });
        },
        check: function (r) {
          if (r.status !== 201 || !r.body.data.tokens) {
            return false;
          }
          adoptSession(r.body);
          return true;
        },
      },
      {
        method: 'POST',
        path: API + '/auth/register',
        label: 'The same email cannot be registered twice.',
        expectation: '409 EMAIL_ALREADY_EXISTS',
        request: { name: 'Ada Lovelace', email: email, password: state.password },
        run: function () {
          return call('POST', API + '/auth/register', {
            body: { name: 'Ada Lovelace', email: email, password: state.password },
          });
        },
        check: function (r) {
          return r.status === 409 && r.body.code === 'EMAIL_ALREADY_EXISTS';
        },
      },
      {
        method: 'POST',
        path: API + '/auth/register',
        label: 'A weak password is rejected with field level detail.',
        expectation: '400 VALIDATION_ERROR naming "password"',
        request: {
          name: 'Weak',
          email: 'weak' + Date.now() + '@example.com',
          password: 'password',
        },
        run: function () {
          return call('POST', API + '/auth/register', {
            body: {
              name: 'Weak',
              email: 'weak' + Date.now() + '@example.com',
              password: 'password',
            },
          });
        },
        check: function (r) {
          return (
            r.status === 400 &&
            r.body.code === 'VALIDATION_ERROR' &&
            r.body.details.some(function (d) {
              return d.field === 'password';
            })
          );
        },
      },
      {
        method: 'POST',
        path: API + '/auth/login',
        label: 'The credentials work on a fresh sign in.',
        expectation: '200 with a new token pair',
        request: { email: email, password: state.password },
        run: function () {
          return call('POST', API + '/auth/login', {
            body: { email: email, password: state.password },
          });
        },
        check: function (r) {
          if (r.status !== 200) {
            return false;
          }
          adoptSession(r.body);
          return true;
        },
      },
      {
        method: 'POST',
        path: API + '/auth/login',
        label: 'A wrong password is refused without saying why.',
        expectation: '401 INVALID_CREDENTIALS',
        run: function () {
          return call('POST', API + '/auth/login', {
            body: { email: email, password: 'Wr0ng!Pass1' },
          });
        },
        check: function (r) {
          return r.status === 401 && r.body.code === 'INVALID_CREDENTIALS';
        },
      },
      {
        method: 'GET',
        path: API + '/auth/me',
        label: 'The access token identifies the caller and its rights.',
        expectation: '200 with the signed-in user',
        run: function () {
          return call('GET', API + '/auth/me', { token: state.accessToken });
        },
        check: function (r) {
          return r.status === 200 && r.body.data.user.email === email;
        },
      },
      {
        method: 'GET',
        path: API + '/tasks',
        label: 'A missing token is refused.',
        expectation: '401 UNAUTHENTICATED',
        run: function () {
          return call('GET', API + '/tasks');
        },
        check: function (r) {
          return r.status === 401 && r.body.code === 'UNAUTHENTICATED';
        },
      },
      {
        method: 'POST',
        path: API + '/tasks',
        label: 'A task is created and owned by the caller.',
        expectation: '201 with owner set to the current user',
        request: { title: 'Verify the deployment', priority: 'high', tags: ['smoke'] },
        run: function () {
          return call('POST', API + '/tasks', {
            token: state.accessToken,
            body: { title: 'Verify the deployment', priority: 'high', tags: ['smoke'] },
          });
        },
        check: function (r) {
          if (r.status !== 201) {
            return false;
          }
          state.taskId = r.body.data.task.id;
          return r.body.data.task.owner === state.user.id;
        },
      },
      {
        method: 'GET',
        path: API + '/tasks?limit=5',
        label: 'The list comes back with pagination metadata.',
        expectation: '200 with meta.totalResults >= 1',
        run: function () {
          return call('GET', API + '/tasks?limit=5&sortBy=createdAt:desc', {
            token: state.accessToken,
          });
        },
        check: function (r) {
          return r.status === 200 && r.body.meta.totalResults >= 1;
        },
      },
      {
        method: 'PATCH',
        path: API + '/tasks/:id',
        label: 'Closing a task stamps the completion time.',
        expectation: '200 with status "done" and completedAt set',
        request: { status: 'done' },
        run: function () {
          return call('PATCH', API + '/tasks/' + state.taskId, {
            token: state.accessToken,
            body: { status: 'done' },
          });
        },
        check: function (r) {
          return (
            r.status === 200 && r.body.data.task.status === 'done' && !!r.body.data.task.completedAt
          );
        },
      },
      {
        method: 'GET',
        path: API + '/tasks/stats',
        label: 'Counts are scoped to the caller.',
        expectation: '200 with done = 1',
        run: function () {
          return call('GET', API + '/tasks/stats', { token: state.accessToken });
        },
        check: function (r) {
          return r.status === 200 && r.body.data.done === 1;
        },
      },
      {
        method: 'POST',
        path: API + '/auth/refresh-tokens',
        label: 'The refresh token rotates into a brand new pair.',
        expectation: '200 with a different refresh token',
        run: function () {
          var previous = state.refreshToken;
          return call('POST', API + '/auth/refresh-tokens', {
            body: { refreshToken: previous },
          }).then(function (r) {
            r.__previous = previous;
            return r;
          });
        },
        check: function (r) {
          if (r.status !== 200) {
            return false;
          }
          var rotated = r.body.data.tokens.refresh.token !== r.__previous;
          state.usedRefreshToken = r.__previous;
          adoptSession(r.body);
          return rotated;
        },
      },
      {
        method: 'POST',
        path: API + '/auth/refresh-tokens',
        label: 'The spent refresh token cannot be replayed.',
        expectation: '401 TOKEN_INVALID',
        run: function () {
          return call('POST', API + '/auth/refresh-tokens', {
            body: { refreshToken: state.usedRefreshToken },
          });
        },
        check: function (r) {
          return r.status === 401 && r.body.code === 'TOKEN_INVALID';
        },
      },
    ];
  }

  function setVerdict(stateName, line) {
    var verdict = $('verdict');
    verdict.setAttribute('data-state', stateName);
    $('verdict-line').textContent = line;
  }

  function runSequence() {
    if (state.running) {
      return;
    }
    state.running = true;
    $('run-flow').disabled = true;
    rail.innerHTML = '';
    clearSession();

    var steps = buildSteps();
    var nodes = steps.map(addStep);
    var meter = $('verdict-meter');
    meter.max = steps.length;
    meter.value = 0;

    var passed = 0;
    var totalMs = 0;

    setVerdict('running', 'Running\u2026');

    var chain = Promise.resolve();
    steps.forEach(function (step, index) {
      chain = chain.then(function () {
        var node = nodes[index];
        node.chip.className = 'chip chip--wait';
        node.chip.textContent = 'running';

        return step.run().then(function (result) {
          var ok = false;
          try {
            ok = step.check(result);
          } catch (error) {
            ok = false;
            result.body = { message: 'Response did not have the expected shape: ' + error.message };
          }

          totalMs += result.ms;
          node.latency.textContent = result.ms + ' ms';
          node.chip.className = 'chip ' + (ok ? 'chip--pass' : 'chip--fail');
          node.chip.textContent = (result.status || 'no reply') + (ok ? ' pass' : ' fail');
          node.item.classList.add(ok ? 'step--pass' : 'step--fail');
          if (step.path.indexOf(':id') !== -1 && state.taskId) {
            node.path.textContent = step.path.replace(':id', state.taskId.slice(0, 8) + '\u2026');
          }
          renderDetail(node.body, step, result);

          if (ok) {
            passed += 1;
          } else {
            node.body.classList.remove('step__body--hidden');
          }
          meter.value = index + 1;
        });
      });
    });

    return chain.then(function () {
      state.running = false;
      $('run-flow').disabled = false;
      var allPassed = passed === steps.length;
      setVerdict(
        allPassed ? 'pass' : 'fail',
        passed + ' of ' + steps.length + ' checks passed in ' + totalMs + ' ms'
      );
      $('verdict-hint').textContent = allPassed
        ? 'Gateway, proxy, validation, authentication, ownership and token rotation all behaved as specified.'
        : 'Open the failed steps above: each one shows what was expected and exactly what came back.';
      return refreshUplink();
    });
  }

  /* --- Manual controls --------------------------------------------------- */

  function flash(message, ok) {
    setVerdict(ok ? 'pass' : 'fail', message);
  }

  function manualEmail() {
    var typed = $('input-email').value.trim();
    if (typed) {
      return typed;
    }
    var generated = 'console+' + Date.now() + '@example.com';
    $('input-email').value = generated;
    return generated;
  }

  function renderTasks(tasks) {
    var list = $('tasklist');
    list.innerHTML = '';
    if (!tasks.length) {
      var empty = document.createElement('li');
      empty.className = 'tasklist__empty';
      empty.textContent = 'No tasks yet.';
      list.appendChild(empty);
      return;
    }
    tasks.forEach(function (task) {
      var item = document.createElement('li');
      item.className = 'tasklist__item';

      var title = document.createElement('span');
      title.className = 'tasklist__title';
      title.textContent = task.title;

      var chip = document.createElement('span');
      chip.className = 'chip' + (task.status === 'done' ? ' chip--pass' : '');
      chip.textContent = task.status;

      item.appendChild(title);
      item.appendChild(chip);
      list.appendChild(item);
    });
  }

  function bind(id, handler) {
    $(id).addEventListener('click', handler);
  }

  bind('run-flow', runSequence);

  bind('reset-flow', function () {
    rail.innerHTML = '';
    clearSession();
    $('verdict-meter').value = 0;
    setVerdict('idle', 'Nothing has run yet.');
    $('verdict-hint').textContent =
      "Each step runs against this page's own origin, so it exercises the gateway, the proxy, the service and MongoDB in one pass.";
  });

  bind('do-register', function () {
    call('POST', API + '/auth/register', {
      body: {
        name: $('input-name').value.trim(),
        email: manualEmail(),
        password: $('input-password').value,
      },
    }).then(function (r) {
      adoptSession(r.body);
      flash(
        r.ok ? 'Account created and signed in.' : 'Could not create the account: ' + describe(r),
        r.ok
      );
    });
  });

  bind('do-login', function () {
    call('POST', API + '/auth/login', {
      body: { email: manualEmail(), password: $('input-password').value },
    }).then(function (r) {
      adoptSession(r.body);
      flash(r.ok ? 'Signed in.' : 'Could not sign in: ' + describe(r), r.ok);
    });
  });

  bind('do-refresh', function () {
    if (!state.refreshToken) {
      flash('Sign in first: there is no refresh token to rotate.', false);
      return;
    }
    call('POST', API + '/auth/refresh-tokens', {
      body: { refreshToken: state.refreshToken },
    }).then(function (r) {
      adoptSession(r.body);
      flash(r.ok ? 'Tokens rotated.' : 'Could not rotate the tokens: ' + describe(r), r.ok);
    });
  });

  bind('do-logout', function () {
    if (!state.refreshToken) {
      flash('There is no session to end.', false);
      return;
    }
    call('POST', API + '/auth/logout', { body: { refreshToken: state.refreshToken } }).then(
      function (r) {
        if (r.ok) {
          clearSession();
        }
        flash(r.ok ? 'Signed out.' : 'Could not sign out: ' + describe(r), r.ok);
      }
    );
  });

  bind('do-create-task', function () {
    if (!state.accessToken) {
      flash('Sign in first: creating a task needs an access token.', false);
      return;
    }
    call('POST', API + '/tasks', {
      token: state.accessToken,
      body: { title: $('input-title').value.trim(), priority: $('input-priority').value },
    }).then(function (r) {
      flash(r.ok ? 'Task added.' : 'Could not add the task: ' + describe(r), r.ok);
      if (r.ok) {
        listTasks();
      }
    });
  });

  function listTasks() {
    return call('GET', API + '/tasks?limit=20&sortBy=createdAt:desc', {
      token: state.accessToken,
    }).then(function (r) {
      if (r.ok) {
        renderTasks(r.body.data);
      }
      return r;
    });
  }

  bind('do-list-tasks', function () {
    if (!state.accessToken) {
      flash('Sign in first: listing tasks needs an access token.', false);
      return;
    }
    listTasks().then(function (r) {
      flash(
        r.ok
          ? 'Loaded ' + r.body.meta.totalResults + ' task(s).'
          : 'Could not load tasks: ' + describe(r),
        r.ok
      );
    });
  });

  bind('do-stats', function () {
    if (!state.accessToken) {
      flash('Sign in first: the counts are scoped to your account.', false);
      return;
    }
    call('GET', API + '/tasks/stats', { token: state.accessToken }).then(function (r) {
      if (!r.ok) {
        flash('Could not load the counts: ' + describe(r), false);
        return;
      }
      var d = r.body.data;
      flash(
        d.total +
          ' total \u00b7 ' +
          d.todo +
          ' to do \u00b7 ' +
          d.in_progress +
          ' in progress \u00b7 ' +
          d.done +
          ' done',
        true
      );
    });
  });

  function describe(result) {
    if (!result.body) {
      return 'HTTP ' + result.status;
    }
    if (result.body.details && result.body.details.length) {
      return result.body.details
        .map(function (d) {
          return d.field + ' ' + d.message;
        })
        .join('; ');
    }
    return result.body.message || 'HTTP ' + result.status;
  }

  /* --- Tabs -------------------------------------------------------------- */

  function selectTab(activeId, activePane) {
    ['auth', 'tasks'].forEach(function (name) {
      var tab = $('tab-' + name);
      var pane = $('pane-' + name);
      var isActive = tab.id === activeId;
      tab.className = 'tab' + (isActive ? ' tab--active' : '');
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      pane.className = 'pane' + (pane.id === activePane ? '' : ' pane--hidden');
    });
  }

  $('tab-auth').addEventListener('click', function () {
    selectTab('tab-auth', 'pane-auth');
  });
  $('tab-tasks').addEventListener('click', function () {
    selectTab('tab-tasks', 'pane-tasks');
  });

  /* --- Boot -------------------------------------------------------------- */

  renderSession();
  refreshUplink();
  setInterval(refreshUplink, 15000);
})();

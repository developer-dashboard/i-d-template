function getNext(response) {
  const link = response.headers.get('link');
  if (!link) {
    return;
  }

  const m = link.match(/^<([^>]*)>\s*;[^,]*rel="?next"?/);
  if (!m) {
    return;
  }
  return m[1];
}

function mkurl(wg, repo, type) {
  if (wg && repo) {
    console.log(`loading remote ${type} for ${wg}/${repo}`);
    return `https://api.github.com/repos/${wg}/${repo}/${type}?state=all`;
  }
  return `${type}.json`;
}

async function getAll(url) {
  let records = [];
  do {
    const response = await fetch(url);
    if (Math.floor(response.status / 100) !== 2) {
      throw new Error(`Error loading <${url}>: ${response.status}`);
    }
    records = records.concat(await response.json());
    url = getNext(response);
  } while (url);
  records.sort((x, y) => x.number - y.number);
  return records;
}

var issues;
var pulls;

async function get(wg, repo) {
  issues = null;
  pulls = null;
  [issues, pulls] = await Promise.all([
    getAll(mkurl(wg, repo, 'issues')), getAll(mkurl(wg, repo, 'pulls'))
  ]);
  issues.forEach(issue => {
    if (issue.pull_request) {
      let pull = window.pulls.find(x => x.url == issue.pull_request.url);
      if (pull) {
        issue.pull_request = pull;
      }
    }
  });
  console.log('loaded all issues and pulls');
}

var issueFilters = {
  assigned: {
    args: [],
    h: 'has an assignee',
    f: function(issue) {
      return issue.assignees.length > 0;
    }
  },

  assigned_to: {
    args: ['string'],
    h: 'assigned to a specific user',
    f: function(login) {
      return issue => issue.assignees.some(assignee => assignee.login === login);
    }
  },

  closed: {
    args: [],
    h: 'is closed',
    f: function(issue) {
      return issue.closed_at;
    }
  },

  open: {
    args: [],
    h: 'is open',
    f: function(issue) {
      return !issue.closed_at;
    }
  },

  n: {
    args: ['integer'],
    h: 'issue by number',
    f: function(i) {
      return issue => issue.number === i;
    }
  },

  label: {
    args: ['string'],
    h: 'has a specific label',
    f: function(name) {
      return issue => issue.labels.some(label => label.name === name);
    }
  },

  labelled: {
    args: [],
    h: 'has any label',
    f: function(issue) {
      return issue.labels.length > 0;
    }
  },

  title: {
    args: ['string'],
    h: 'search title with a regular expression',
    f: function(re) {
      re = new RegExp(re);
      return issue => issue.title.match(re);
    }
  },

  body: {
    args: ['string'],
    h: 'search body with a regular expression',
    f: function(re) {
      re = new RegExp(re);
      return issue => issue.body.match(re);
    }
  },

  text: {
    args: ['string'],
    h: 'search title and body with a regular expression',
    f: function(re) {
      re = new RegExp(re);
      return issue => issue.title.match(re) || issue.body.match(re);
    }
  },

  pr: {
    args: [],
    h: 'is a pull request',
    f: function(issue) {
      return issue.pull_request;
    }
  },

  issue: {
    args: [],
    h: 'is a plain issue, i.e., not(pr)',
    f: function(issue) {
      return !issue.pull_request;
    }
  },

  merged: {
    args: [],
    h: 'a merged pull request',
    f: function(issue) {
      return issue.pull_request && issue.pull_request.merged_at;
    }
  },

  or: {
    args: ['filter', 'filter'],
    h: 'union',
    f: function(a, b) {
      return x => a(x) || b(x);
    }
  },

  and: {
    args: ['filter', 'filter'],
    h: 'intersection',
    f: function(a, b) {
      return x => a(x) && b(x);
    }
  },

  not: {
    args: ['filter'],
    h: 'exclusion',
    f: function(a) {
      return x => !a(x);
    }
  },

  closed_since: {
    args: ['string'],
    h: 'issues closed since the date and time',
    f: function(since) {
      if (typeof since === 'string') {
        since = new Date(since);
      } else if (since instanceof Date) {
        since = since.getTime();
      }
      return issue => Date.parse(issue.closed_at) > since;
    }
  }
};

class Parser {
  constructor(s) {
    this.str = s;
    this.skipws();
  }

  skipws() {
    this.str = this.str.trimLeft();
  }

  jump(idx) {
    this.str = this.str.slice(idx);
    this.skipws();
  }

  get next() {
    return this.str.charAt(0);
  }

  parseName() {
    let m = this.str.match(/^[a-zA-Z](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?/);
    if (!m) {
      return;
    }

    this.jump(m[0].length);
    return m[0];
  }

  parseSeparator(separator) {
    if (this.next !== separator) {
      throw new Error(`Expecting separator ${separator}`);
    }
    this.jump(1);
  }

  parseString() {
    let i = this.str.indexOf(')');
    if (i < 0) {
      throw new Error(`Unterminated string`);
    }
    let s = this.str.slice(0, i).trim();
    this.jump(i);
    return s;
  }

  parseNumber() {
    let m = this.str.match(/^\d+/);
    if (!m) {
      return;
    }
    this.jump(m[0].length);
    return parseInt(m[0], 10);
  }

  parseFilter() {
    let name = this.parseName();
    if (!name) {
      let n = this.parseNumber();
      if (!isNaN(n)) {
        return issueFilters.n.f.call(null, n);
      }
      return;
    }
    let f = issueFilters[name];
    if (!f) {
      throw new Error(`Unknown filter: ${name}`);
    }
    if (f.args.length === 0) {
      return f.f;
    }
    let args = [];
    f.args.forEach((arg, idx) => {
      this.parseSeparator((idx === 0) ? '(' : ',');
      if (arg === 'string') {
        args.push(this.parseString());
      } else if (arg === 'integer') {
        args.push(this.parseNumber());
      } else if (arg === 'filter') {
        args.push(this.parseFilter());
      } else {
        throw new Error(`Error in filter ${name} definition`);
      }
    });
    this.parseSeparator(')');
    return f.f.apply(null, args);
  }
}

function filterIssues(str) {
  let output = issues;
  let parser = new Parser(str);
  let f = parser.parseFilter();
  while (f) {
    output = output.filter(f);
    f = parser.parseFilter();
  }
  return output;
}

function shortDesc(x) {
  return `${x.title} (#${x.number})`;
}

var debounces = {};
function debounce(f) {
  return e => {
    if (debounces[f.name]) {
      window.clearTimeout(debounces[f.name]);
      delete debounces[f.name];
    }
    if (e.key === "Enter") {
      f(true);
    } else {
      debounces[f.name] = window.setTimeout(_ => {
        delete debounces[f.name];
        f(false)
      }, 100);
    }
  }
}

function makeRow(issue) {
  function cellID() {
    let td = document.createElement('td');
    td.className = 'id';
    let a = document.createElement('a');
    a.href = issue.html_url;
    a.innerText = issue.number;
    td.appendChild(a);
    return td;
  }

  function cellTitle() {
    let td = document.createElement('td');
    let div = document.createElement('div');
    div.innerText = issue.title;
    div.onclick = e => e.target.parentNode.classList.toggle('active');
    div.style.cursor = 'pointer';
    td.appendChild(div);
    div = document.createElement('div');
    div.innerText = issue.body;
    div.className = 'extra';
    td.appendChild(div);
    return td;
  }

  function addUser(td, user, short) {
    let image = document.createElement('img');
    image.src = user.avatar_url + '&s=32';
    image.width = 16;
    image.height = 16;
    td.appendChild(image);
    let a = document.createElement('a');
    a.href = user.html_url;
    a.innerText = user.login;
    if (short) {
      a.classList.add('short');
    }
    td.appendChild(a);
  }

  function cellUser() {
    let td = document.createElement('td');
    td.className = 'user';
    addUser(td, issue.user);
    return td;
  }

  function cellAssignees() {
    let td = document.createElement('td');
    td.className = 'user';
    if (issue.assignees) {
      issue.assignees.forEach(user => addUser(td, user, issue.assignees.length > 1));
    }
    return td;
  }

  function cellState() {
    let td = document.createElement('td');
    td.innerText = issue.state;
    return td;
  }

  function cellLabels() {
    let td = document.createElement('td');
    td.className = 'label';
    issue.labels.forEach(label => {
      let sp = document.createElement('span');
      sp.style.backgroundColor = '#' + label.color;
      sp.innerText = label.name;
      td.appendChild(sp);
    });
    return td;
  }

  let tr = document.createElement('tr');
  tr.appendChild(cellID());
  tr.appendChild(cellTitle());
  tr.appendChild(cellState());
  tr.appendChild(cellUser());
  tr.appendChild(cellAssignees());
  tr.appendChild(cellLabels());
  return tr;
}

function redraw(now) {
  let v = document.getElementById('filter');
  let h = document.getElementById('help');
  let d = document.getElementById('display');
  let status = document.getElementById('status');

  if (v.value.charAt(0) == '/') {
    if (!now) {
      return;
    }
    v = v.value.slice(1).split(' ').map(x => x.trim());
    v.value = '';

    let cmd = v[0].toLowerCase();
    if (cmd === 'help') {
      status.innerText = 'help shown';
      h.classList.remove('hidden');
    } else if (cmd === 'local') {
      local = true;
      status.innerText = 'retrieving local JSON files';
      get().then(redraw);
    } else if (cmd === 'remote') {
      local = false;
      if (v.length < 3) {
        status.innerText = `need to specify github repo`;
      } else {
        get(v[1], v[2]).then(redraw)
          .then(
            _ => status.innerText = `successfully loaded ${v[1]}/${v[2]} from GitHub`,
            e => status.innerText = `Error: ${e.message}`);
        status.innerText = `fetching from GitHub for ${v[1]}/${v[2]}`;
      }
    } else {
      status.innerText = 'unknown command: /' + v.join(' ');
    }
    d.classList.add('hidden');
    return;
  }

  if (!issues) {
    if (now) {
      status.innerText = 'Still loading...';
    }
    return;
  }

  h.classList.add('hidden');
  d.classList.remove('hidden');

  try {
    let subset = filterIssues(v.value);
    let tbody = document.getElementById('tbody');
    tbody.innerHTML = '';
    subset.forEach(issue => {
      tbody.appendChild(makeRow(issue));
    });
    status.innerText = `${subset.length} records shown`;
  } catch (e) {
    if (now) { // Only show errors when someone hits enter.
      status.innerText = `Error: ${e.message}`;
      console.log(e);
    }
  }
}

function generateHelp() {
  let functionhelp = document.getElementById('functions');
  Object.keys(issueFilters).forEach(k => {
    let li = document.createElement('li');
    let arglist = '';
    if (issueFilters[k].args.length > 0) {
      arglist = '(' + issueFilters[k].args.map(x => '<' + x + '>').join(', ') + ')';
    }
    let help = '';
    if (issueFilters[k].h) {
      help = ' - ' + issueFilters[k].h;
    }
    li.innerText = `${k}${arglist}${help}`;
    functionhelp.appendChild(li);
  });
}

window.onload = () => {
  document.getElementById('filter').onkeypress = debounce(redraw);
  generateHelp();
  get().then(redraw);
}

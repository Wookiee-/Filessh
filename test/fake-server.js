const path = require('path');
const fs = require('fs');
const os = require('os');
const REPO = path.join(__dirname, '..');
const { execFileSync } = require('child_process');
function genHostKey(kind, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filessh-e2e-key-'));
  execFileSync('ssh-keygen', ['-t', kind, ...args, '-f', path.join(dir, 'key'), '-N', '', '-q']);
  return fs.readFileSync(path.join(dir, 'key'));
}
const hostKeys = [
  genHostKey('rsa', ['-b', '2048']),
  genHostKey('ecdsa', ['-b', '256']),
  genHostKey('ed25519', []),
];
const { Server } = require(path.join(REPO, 'node_modules', 'ssh2'));

function startServer(port) {
  return new Promise((resolve) => {
    const srv = new Server({ hostKeys }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'testpw') ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () => client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (a) => a());
        session.on('shell', (acceptFn) => {
          const stream = acceptFn();
          stream.write('tester@test:~$ '); // prompt sent EXACTLY once
          let line = '';
          stream.on('data', (d) => {
            stream.write(d); // pty echo
            line += d.toString();
            const idx = line.indexOf('\n');
            if (idx >= 0) {
              const cmd = line.slice(0, idx).trim();
              line = line.slice(idx + 1);
              if (cmd === 'exit') { stream.write('logout\n'); stream.exit(0); stream.end(); return; }
              if (cmd.startsWith('echo ')) stream.write(cmd.slice(5) + '\n');
              stream.write('tester@test:~$ ');
            }
          });
        });
      }));
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}


(async () => {
  const srv = await startServer(Number(process.argv[2] || 2222));
  console.log('FAKE_SSH_UP');
})();

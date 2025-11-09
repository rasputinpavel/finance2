// test-dns.ts
import dns from 'dns';

const hostname = 'mail.proxied.host';
console.log(`[Test] Attempting DNS lookup for: ${hostname}`);

dns.lookup(hostname, (err, address) => {
    if (err) {
        console.error('[Test] DNS lookup FAILED:', err);
        process.exit(1);
    }
    console.log(`[Test] DNS lookup SUCCESS. IP Address: ${address}`);
});

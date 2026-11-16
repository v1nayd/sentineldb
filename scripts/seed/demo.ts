import { fmt, minutes, prng, q, ReplayScript, type Rng, type Ts } from "./replay";

/**
 * Deterministic synthetic demo dataset (~240 incidents, Jan-Sep 2026), replayed through the real lifecycle.
 *
 * Structure that later milestones rely on:
 *   * 12 incident FAMILIES (phishing, ransomware, ...), each with several narrative templates, so narratives about the
 *     same kind of attack are worded differently (the vector search has something to do).
 *   * CAMPAIGNS: groups of 2-6 incidents of one family, close in time, sharing IOCs and sometimes assets (the
 *     relational evidence). Plus three cross-family CHAINS (macro malware -> beaconing -> exfiltration) that share one
 *     C2 domain while their narratives differ.
 *   * Ground truth (family, campaign, chain) is written to demo_labels.json, NOT into the database, so ranking code can
 *     never read it. Caveat for M4: the same author wrote data and labels; evaluation queries must be written separately
 *     and fixed before any method is run (docs/DECISIONS.md, evaluation honesty).
 *   * Lifecycle realism: most old incidents are closed, recent ones are still open; some are reassigned, reopened,
 *     re-investigated after a failed containment, have IOCs dismissed as false positives, have a wrong IOC unlinked
 *     (audited), or are archived.
 *
 * All identifiers are documentation-reserved: RFC 5737 IPs (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24),
 * .example / .invalid domains, random hex hashes. Internal asset IPs are RFC 1918.
 */

export const DEMO_SEED = 20261027;
const START = new Date("2026-01-05T00:00:00Z");
const HORIZON = new Date("2026-09-30T18:00:00Z"); // "now" for the dataset: nothing happens after this
const ARCHIVE_DAY = new Date("2026-09-22T09:00:00Z");

type Sev = "low" | "medium" | "high" | "critical";
type IocType = "ip" | "domain" | "file_hash" | "email" | "url";

interface Family {
  key: string;
  count: number;
  sev: Array<readonly [Sev, number]>;
  playbook: string;
  iocTypes: IocType[];
  assets: string[];             // asset names this family plausibly touches
  titles: string[];
  openings: string[];
  details: string[];            // {ioc} = an IOC value is quoted in the narrative
  impacts: string[];
  linkNotes: string[];
  investigation: string[];
  containment: string[];
  resolution: string[];
  impactText: string[];
  containable: number;          // probability the path includes a containment step
}

const USERS = [
  { id: 1, name: "Priya Raman", email: "priya.raman@sentinel.example", role: "admin" },
  { id: 2, name: "Marcus Webb", email: "marcus.webb@sentinel.example", role: "admin" },
  { id: 3, name: "Aisha Khan", email: "aisha.khan@sentinel.example", role: "analyst" },
  { id: 4, name: "Tomas Rivera", email: "tomas.rivera@sentinel.example", role: "analyst" },
  { id: 5, name: "Mei Lin", email: "mei.lin@sentinel.example", role: "analyst" },
  { id: 6, name: "Jonas Becker", email: "jonas.becker@sentinel.example", role: "analyst" },
  { id: 7, name: "Fatima Noor", email: "fatima.noor@sentinel.example", role: "analyst" },
  { id: 8, name: "Ravi Menon", email: "ravi.menon@sentinel.example", role: "analyst" },
  { id: 9, name: "Elena Petrova", email: "elena.petrova@sentinel.example", role: "analyst" },
  { id: 10, name: "Sam Taylor", email: "sam.taylor@sentinel.example", role: "analyst" },
  { id: 11, name: "Noah Kim", email: "noah.kim@sentinel.example", role: "analyst" }, // joined last week: zero incidents (workload view must show him)
] as const;
const ADMINS = [1, 2];
const WORKING_ANALYSTS = [3, 4, 5, 6, 7, 8, 9, 10];

const ASSETS: Array<[string, string, string, number, string]> = [
  // name, type, ip, criticality, department
  ["dc-01", "server", "10.10.0.10", 5, "IT"], ["dc-02", "server", "10.10.0.11", 5, "IT"],
  ["bastion-01", "server", "10.10.0.20", 4, "IT"], ["fileserver-01", "server", "10.10.1.30", 4, "IT"],
  ["fileserver-02", "server", "10.10.1.31", 3, "Finance"], ["build-01", "server", "10.20.4.40", 3, "Engineering"],
  ["build-02", "server", "10.20.4.41", 3, "Engineering"], ["db-prod-01", "server", "10.30.0.50", 5, "Engineering"],
  ["backup-01", "server", "10.10.2.60", 4, "IT"], ["k8s-node-01", "server", "10.30.1.71", 4, "Engineering"],
  ["k8s-node-02", "server", "10.30.1.72", 4, "Engineering"], ["lab-rdp-01", "server", "10.40.5.50", 2, "Research"],
  ["mail-gw-01", "server", "10.10.3.25", 4, "IT"],
  ["customer-portal", "application", "10.30.2.20", 5, "Engineering"], ["webmail", "application", "10.10.3.10", 4, "IT"],
  ["hr-portal", "application", "10.10.4.15", 4, "HR"], ["payments-api", "application", "10.30.2.40", 5, "Finance"],
  ["sso-idp", "application", "10.10.0.30", 5, "IT"], ["intranet-wiki", "application", "10.10.4.40", 2, "IT"],
  ["crm-app", "application", "10.30.2.60", 3, "Sales"], ["export-bucket", "application", "10.30.3.10", 4, "Engineering"],
  ["ws-fin-07", "workstation", "10.50.1.107", 3, "Finance"], ["ws-fin-12", "workstation", "10.50.1.112", 3, "Finance"],
  ["ws-hr-03", "workstation", "10.50.2.103", 3, "HR"], ["ws-eng-21", "workstation", "10.50.3.121", 2, "Engineering"],
  ["ws-eng-34", "workstation", "10.50.3.134", 2, "Engineering"], ["ws-exec-02", "workstation", "10.50.4.102", 4, "Executive"],
  ["ws-sales-15", "workstation", "10.50.5.115", 2, "Sales"], ["ws-it-05", "workstation", "10.50.6.105", 3, "IT"],
  ["laptop-ops-09", "workstation", "10.50.7.109", 3, "Operations"],
  ["fw-edge-01", "network_device", "10.0.0.1", 5, "IT"], ["vpn-gw-01", "network_device", "10.0.0.5", 5, "IT"],
  ["core-sw-01", "network_device", "10.0.0.2", 4, "IT"], ["wlan-ctrl-01", "network_device", "10.0.0.8", 3, "IT"],
];

const PLAYBOOKS: Array<[string, string, string]> = [
  ["Phishing triage", "phishing", "1. Pull the message and headers. 2. Block sender and URLs. 3. Find recipients who clicked. 4. Reset exposed credentials. 5. Notify users."],
  ["Business email compromise", "bec", "1. Freeze the payment. 2. Verify the request out of band. 3. Check mailbox rules and sign-ins. 4. Contact the bank. 5. Report."],
  ["Ransomware response", "ransomware", "1. Isolate affected hosts. 2. Disable the accounts involved. 3. Identify the encryptor and scope. 4. Restore from clean backups. 5. Post-incident review."],
  ["Brute force and spraying", "brute_force", "1. Block the sources. 2. Check for any successful logins. 3. Enforce lockout and MFA. 4. Review exposed services."],
  ["Credential stuffing", "credential_stuffing", "1. Rate-limit the login endpoint. 2. Identify accessed accounts. 3. Force password resets. 4. Notify affected customers."],
  ["Malware containment", "malware", "1. Isolate the endpoint. 2. Collect the sample and hash. 3. Sweep the fleet for the hash. 4. Reimage. 5. Block callbacks."],
  ["Resource abuse (cryptomining)", "cryptomining", "1. Kill the process. 2. Find the persistence. 3. Rotate exposed keys. 4. Patch the entry point."],
  ["Data exfiltration", "exfiltration", "1. Preserve logs. 2. Quantify what left. 3. Revoke access. 4. Involve legal and privacy. 5. Notify if required."],
  ["Web application attack", "web", "1. Block the attacking sources at the WAF. 2. Check for web shells. 3. Patch the vulnerable code. 4. Review database access."],
  ["Command-and-control beaconing", "c2", "1. Sinkhole or block the destination. 2. Isolate the host. 3. Identify the implant. 4. Hunt for the same beacon elsewhere."],
  ["Cloud misconfiguration", "cloud", "1. Remove public access. 2. Review access logs. 3. Rotate any exposed secrets. 4. Add a policy guardrail."],
  ["DDoS mitigation", "ddos", "1. Engage upstream scrubbing. 2. Rate-limit at the edge. 3. Scale the affected service. 4. Review after traffic normalises."],
];

const FAMILIES: Family[] = [
  {
    key: "phishing_credential", count: 34, sev: [["medium", 4], ["high", 5], ["critical", 1]], playbook: "Phishing triage",
    iocTypes: ["domain", "url", "email"], assets: ["webmail", "sso-idp", "mail-gw-01", "hr-portal"], containable: 0.5,
    titles: ["Credential phishing campaign against {dept}", "Fake sign-in page reported by {dept} staff", "Mailbox quota phishing email", "Phishing link clicked by {dept} user", "Shared-document lure harvesting passwords"],
    openings: [
      "Several people in {dept} received an email asking them to confirm their account details through a link.",
      "A user in {dept} reported a message that claimed their mailbox was almost full and needed to be verified.",
      "The mail gateway released {n} messages that imitated a document-sharing notification from a colleague.",
      "An employee forwarded a suspicious message to the security mailbox after entering their password on the page it linked to.",
    ],
    details: [
      "The link led to a page that copied the look of our single sign-on portal and posted whatever was typed to an outside server.",
      "The landing page was hosted on {ioc}, which was registered a few days before the messages were sent.",
      "Sign-in logs show that one of the targeted accounts was used from an unfamiliar network shortly after the message arrived.",
      "The sender address was spoofed to look internal, but the reply-to header pointed to {ioc}.",
      "Users who opened the attachment were shown a blurred document and asked to log in to view it.",
    ],
    impacts: [
      "At least {n} people entered their credentials before the page was blocked.",
      "No successful sign-ins with the harvested passwords were found, but the accounts were reset as a precaution.",
      "One account was used to send further phishing messages internally before it was disabled.",
    ],
    linkNotes: ["Phishing landing page", "Reply-to address used by the lure", "Sender infrastructure", "Credential collection endpoint"],
    investigation: ["Pulled all copies of the message from mailboxes and collected the headers.", "Identified the users who clicked from proxy logs.", "Checked sign-in logs for the targeted accounts for unusual locations."],
    containment: ["Blocked the domain and URL at the proxy and mail gateway.", "Forced password resets and revoked sessions for the users who entered credentials."],
    resolution: ["No further sign-ins from the attacker infrastructure. Users notified and awareness note sent.", "Credentials rotated, MFA confirmed on all affected accounts."],
    impactText: ["Mailboxes received the lure; credentials of some users exposed", "Sign-in portal impersonated; no compromise of the service itself", "Mail gateway let the messages through; filter rule added"],
  },
  {
    key: "bec_payment_fraud", count: 18, sev: [["medium", 2], ["high", 5], ["critical", 2]], playbook: "Business email compromise",
    iocTypes: ["email", "domain"], assets: ["webmail", "payments-api", "ws-fin-07", "ws-fin-12", "ws-exec-02"], containable: 0.3,
    titles: ["Executive impersonation payment request", "Supplier bank details change request", "Urgent wire transfer email to {dept}", "Invoice redirection attempt"],
    openings: [
      "Accounts payable received an urgent request, apparently from a senior executive, to pay a new supplier the same day.",
      "A supplier appeared to email {dept} asking that future invoices be paid into a different bank account.",
      "A message signed with the finance director's name asked a junior colleague to buy gift cards and send the codes.",
      "Finance was asked by email to move a scheduled payment forward and change the beneficiary.",
    ],
    details: [
      "The sending domain {ioc} differed from ours by a single character.",
      "The real supplier confirmed by phone that they had not changed their bank details.",
      "The message thread had been copied from a genuine conversation, which suggests an earlier mailbox compromise at the supplier.",
      "Mailbox rules on the recipient's account had been altered to hide replies from the real executive.",
    ],
    impacts: [
      "The payment was stopped before it left the bank.",
      "One transfer was made before the fraud was noticed; the bank has started a recall.",
      "No money was sent; staff recognised the request as unusual and reported it.",
    ],
    linkNotes: ["Look-alike sender domain", "Fraudster reply address", "Domain used in the fake invoice"],
    investigation: ["Verified the request with the executive by phone: not genuine.", "Reviewed mailbox rules and sign-ins on the recipient account.", "Asked the bank to put a hold on the beneficiary account."],
    containment: ["Blocked the look-alike domain and removed the hidden mailbox rule."],
    resolution: ["Funds held by the bank. Finance reminded of the call-back procedure.", "Supplier informed about the compromise on their side."],
    impactText: ["Finance mailbox targeted with a fraudulent payment request", "Payment workflow abused; no system compromise", "Executive identity impersonated"],
  },
  {
    key: "ransomware", count: 14, sev: [["high", 2], ["critical", 6]], playbook: "Ransomware response",
    iocTypes: ["file_hash", "ip", "domain"], assets: ["fileserver-01", "fileserver-02", "backup-01", "ws-fin-07", "ws-hr-03", "dc-01"], containable: 0.9,
    titles: ["Ransom note on file share", "Files encrypted on {asset}", "Ransomware outbreak in {dept}", "Mass file renaming detected"],
    openings: [
      "Users in {dept} reported that documents on the shared drive would no longer open.",
      "Endpoint protection raised an alert for a process rewriting hundreds of files per minute on {asset}.",
      "A text file appeared in every folder of the {dept} share demanding payment in cryptocurrency.",
      "Backups failed overnight and the operators found the backup catalogue had been deleted.",
    ],
    details: [
      "Every affected file had a new extension and could not be read.",
      "The encryptor binary had the hash {ioc} and was launched through a scheduled task.",
      "Before encrypting, the attacker deleted volume shadow copies and stopped the backup agent.",
      "The process was started from an account belonging to a contractor whose password had been reused elsewhere.",
      "Network logs show the host talking to {ioc} shortly before the encryption began.",
    ],
    impacts: [
      "Roughly {n} gigabytes of shared documents were encrypted.",
      "Encryption was stopped on the first server; other shares were not touched.",
      "Restoring from the offline backup took about {h} hours.",
    ],
    linkNotes: ["Encryptor sample", "Ransomware staging server", "Payment portal named in the note", "Initial access source"],
    investigation: ["Isolated the affected hosts from the network.", "Collected the encryptor sample and the ransom note.", "Identified the account used to launch the encryptor."],
    containment: ["Disabled the compromised account and blocked the staging address.", "All affected hosts isolated; no further encryption observed."],
    resolution: ["Data restored from offline backups; hosts reimaged.", "Root cause: reused contractor password without MFA; MFA now enforced."],
    impactText: ["Shared files encrypted", "Backup agent stopped and shadow copies deleted", "Host reimaged after encryption"],
  },
  {
    key: "brute_force", count: 30, sev: [["low", 3], ["medium", 5], ["high", 3]], playbook: "Brute force and spraying",
    iocTypes: ["ip"], assets: ["bastion-01", "vpn-gw-01", "lab-rdp-01", "webmail", "sso-idp"], containable: 0.4,
    titles: ["Repeated failed SSH logins on {asset}", "Password spraying against {asset}", "Remote desktop brute force on {asset}", "VPN login failures from one source"],
    openings: [
      "Authentication logs on {asset} show hundreds of failed password attempts in a short period.",
      "The identity provider flagged a burst of failed logins spread across many accounts.",
      "A scan showed remote desktop reachable from the internet on {asset}, with repeated connection attempts in its logs.",
      "Monitoring alerted on {n} failed VPN logins in under an hour.",
    ],
    details: [
      "Almost all attempts came from {ioc}.",
      "A small set of common passwords was tried against dozens of accounts from rotating addresses.",
      "The attempts targeted the root and admin accounts first, then common first names.",
      "The service used a weak local administrator password.",
      "Two accounts were locked out by the lockout policy.",
    ],
    impacts: [
      "No successful login was found.",
      "One successful sign-in was recorded from an unusual country and the session was revoked.",
      "The attempts stopped after the source was blocked.",
    ],
    linkNotes: ["Source of the failed logins", "Spraying proxy", "Scanner address"],
    investigation: ["Checked for any successful authentication from the sources.", "Compared the targeted usernames with the directory."],
    containment: ["Blocked the source addresses at the firewall.", "Restricted the service to the VPN only."],
    resolution: ["Lockout and MFA confirmed; no successful logins.", "Service no longer exposed to the internet."],
    impactText: ["Login endpoint targeted", "Accounts locked out", "Exposed remote access service"],
  },
  {
    key: "credential_stuffing", count: 18, sev: [["medium", 2], ["high", 4], ["critical", 1]], playbook: "Credential stuffing",
    iocTypes: ["ip"], assets: ["customer-portal", "crm-app", "sso-idp"], containable: 0.6,
    titles: ["Credential stuffing on customer portal", "Account takeover attempts on {asset}", "Login surge using leaked passwords"],
    openings: [
      "The customer portal received a very large volume of login requests in a few hours.",
      "Support received complaints from customers whose saved addresses had been changed.",
      "The fraud team noticed many logins from a hosting provider rather than home connections.",
    ],
    details: [
      "The email and password pairs match a recent public leak from another website.",
      "Most attempts failed, but each request came from a different address, defeating per-address limits.",
      "Requests carried an outdated browser signature and arrived at a perfectly regular rate.",
      "The successful logins all came through {ioc}.",
    ],
    impacts: [
      "About {n} customer accounts were accessed before rate limiting started.",
      "No customer account was accessed; all attempts were rejected.",
      "Loyalty points were moved out of several accounts.",
    ],
    linkNotes: ["Botnet node used for stuffing", "Proxy used by the successful logins"],
    investigation: ["Identified the accounts with successful logins from the attack sources.", "Confirmed the credential pairs come from a third-party leak."],
    containment: ["Enabled stricter rate limiting and a challenge on the login page."],
    resolution: ["Affected customers reset and notified.", "Bot mitigation enabled permanently on the login endpoint."],
    impactText: ["Customer accounts accessed with reused passwords", "Login endpoint overloaded"],
  },
  {
    key: "malware_macro", count: 26, sev: [["medium", 5], ["high", 4], ["critical", 1]], playbook: "Malware containment",
    iocTypes: ["file_hash", "domain", "url"], assets: ["ws-fin-07", "ws-fin-12", "ws-hr-03", "ws-sales-15", "ws-eng-21", "laptop-ops-09"], containable: 0.8,
    titles: ["Invoice attachment macro", "Malicious document opened in {dept}", "Loader detected on {asset}", "Script launched from email attachment"],
    openings: [
      "{dept} received a message with a supposed overdue invoice attached.",
      "Endpoint protection blocked a script that was started by a spreadsheet on {asset}.",
      "A user opened a document that asked them to enable editing to see its content.",
      "An attachment disguised as a shipping notice was opened on {asset}.",
    ],
    details: [
      "Enabling content launched a script that downloaded a second file from {ioc}.",
      "The dropped file had the hash {ioc} and tried to add itself to the startup folder.",
      "The script contacted an external server and waited for instructions.",
      "The document came from a real supplier address whose mailbox had been compromised.",
    ],
    impacts: [
      "The second stage was blocked before it ran.",
      "The workstation was infected and had to be reimaged.",
      "The same attachment reached {n} other mailboxes but was not opened.",
    ],
    linkNotes: ["Macro download location", "Dropped payload", "Callback domain", "Attachment hash"],
    investigation: ["Collected the attachment and the dropped file.", "Searched the fleet for the same hash."],
    containment: ["Isolated the workstation from the network.", "Blocked the download domain at the proxy."],
    resolution: ["Workstation reimaged; no other hosts with the hash.", "Macros from the internet are now blocked by policy."],
    impactText: ["Workstation infected and reimaged", "Malicious attachment opened; second stage blocked"],
  },
  {
    key: "cryptomining", count: 16, sev: [["low", 3], ["medium", 5], ["high", 1]], playbook: "Resource abuse (cryptomining)",
    iocTypes: ["domain", "ip", "file_hash"], assets: ["build-01", "build-02", "k8s-node-01", "k8s-node-02", "lab-rdp-01"], containable: 0.6,
    titles: ["Cryptominer on {asset}", "Unexpected CPU load on {asset}", "Mining pool traffic from the cluster"],
    openings: [
      "The processor on {asset} stayed at full load for days.",
      "Cloud cost alerts fired because the cluster scaled out overnight without any deployment.",
      "Network monitoring saw a server opening long-lived connections to an unknown service.",
    ],
    details: [
      "An unknown process was connecting to the mining pool {ioc}.",
      "The miner persisted through a scheduled job created under a service account.",
      "A container image pulled from a public registry contained the miner.",
      "Access came through an exposed management interface with no password.",
    ],
    impacts: [
      "Builds slowed down for {h} hours.",
      "No data access was found; the impact was compute cost.",
      "The cluster ran extra nodes for about {h} hours.",
    ],
    linkNotes: ["Mining pool", "Miner binary", "Download source"],
    investigation: ["Found the persistence and the process tree.", "Checked the service account for other activity."],
    containment: ["Killed the process and removed the scheduled job."],
    resolution: ["Entry point patched and keys rotated.", "Image pinned to an internal registry."],
    impactText: ["CPU exhausted by an unauthorised miner", "Extra cloud cost; no data accessed"],
  },
  {
    key: "data_exfiltration", count: 16, sev: [["medium", 2], ["high", 4], ["critical", 2]], playbook: "Data exfiltration",
    iocTypes: ["domain", "ip", "url"], assets: ["fileserver-01", "db-prod-01", "crm-app", "laptop-ops-09", "ws-eng-34"], containable: 0.7,
    titles: ["Bulk copy by departing employee", "Large upload to personal cloud storage", "Database export to unknown host", "Unusual outbound transfer from {asset}"],
    openings: [
      "A user who had resigned copied several gigabytes of project archives the night before their last day.",
      "Data-loss monitoring flagged an upload of {n} gigabytes from {asset} to a file-sharing site.",
      "A database account ran a full export of the customer table at an unusual hour.",
      "Firewall logs show a steady outbound transfer from {asset} for several hours.",
    ],
    details: [
      "The files went to {ioc}, a personal storage service not used by the company.",
      "The transfer was split into small chunks to avoid volume alerts.",
      "The account used had been granted broad read access during a past project and never reviewed.",
      "The destination was {ioc}.",
    ],
    impacts: [
      "Project source code and design documents left the network.",
      "The export contained names and email addresses of customers.",
      "The transfer was stopped after about {n} percent of the data had left.",
    ],
    linkNotes: ["Exfiltration destination", "Upload endpoint", "Staging server"],
    investigation: ["Preserved proxy and file access logs.", "Quantified which files left and when."],
    containment: ["Revoked the account's access and blocked the destination."],
    resolution: ["Legal and privacy informed; access review completed.", "Data-loss rule tightened for that destination."],
    impactText: ["Confidential files copied out", "Customer data exported", "Source code transferred externally"],
  },
  {
    key: "web_exploitation", count: 22, sev: [["medium", 3], ["high", 5], ["critical", 2]], playbook: "Web application attack",
    iocTypes: ["ip", "url", "file_hash"], assets: ["customer-portal", "hr-portal", "intranet-wiki", "payments-api", "crm-app"], containable: 0.7,
    titles: ["SQL injection attempts on {asset}", "Web shell found on {asset}", "Exploitation of outdated plugin on {asset}", "Path traversal requests against {asset}"],
    openings: [
      "The web application firewall logged a burst of requests to {asset} containing database syntax.",
      "A file integrity check found a new script in the upload directory of {asset}.",
      "Error logs on {asset} filled with database errors after a scan from one address.",
      "A security researcher reported that {asset} returned other users' records when a parameter was changed.",
    ],
    details: [
      "The requests came from {ioc} and walked through every parameter of the search form.",
      "The uploaded script accepted commands through a hidden parameter; its hash is {ioc}.",
      "The vulnerable component was a plugin two major versions behind.",
      "The attacker used the injection to read the users table.",
    ],
    impacts: [
      "No data was returned to the attacker; the firewall blocked the payloads.",
      "Password hashes for about {n} accounts may have been read.",
      "The web shell was used to list directories but not to move further.",
    ],
    linkNotes: ["Attacking source", "Web shell file", "Exploit request path"],
    investigation: ["Reviewed web and database logs for successful payloads.", "Searched the web root for other unexpected files."],
    containment: ["Blocked the source at the firewall and removed the web shell."],
    resolution: ["Plugin patched and parameterised queries deployed.", "Affected passwords reset."],
    impactText: ["Public web application attacked", "Web shell planted on the server", "Database queried through injection"],
  },
  {
    key: "c2_beaconing", count: 18, sev: [["medium", 2], ["high", 5], ["critical", 1]], playbook: "Command-and-control beaconing",
    iocTypes: ["domain", "ip"], assets: ["ws-eng-21", "ws-eng-34", "ws-it-05", "ws-exec-02", "laptop-ops-09", "dc-02"], containable: 0.8,
    titles: ["Beaconing workstation", "Periodic callbacks from {asset}", "Suspicious DNS lookups from {asset}"],
    openings: [
      "Network monitoring flagged {asset} contacting the same external domain at regular intervals.",
      "DNS logs show {asset} resolving long random-looking subdomains every few minutes.",
      "An endpoint alert reported an unsigned process holding a persistent outbound connection on {asset}.",
    ],
    details: [
      "The destination {ioc} has no legitimate business use.",
      "The small encrypted payloads are consistent with command-and-control check-ins.",
      "The process injected itself into a browser to blend in.",
      "The interval was almost exactly sixty seconds, with a small random jitter.",
    ],
    impacts: [
      "No commands beyond reconnaissance were observed.",
      "The implant collected browser credentials before it was found.",
      "Two other hosts showed the same beacon pattern.",
    ],
    linkNotes: ["Beacon destination", "C2 server address"],
    investigation: ["Captured traffic to confirm the beacon pattern.", "Hunted for the same destination across DNS logs."],
    containment: ["Sinkholed the domain and isolated the host."],
    resolution: ["Implant removed; host reimaged.", "No other hosts beaconing after the sinkhole."],
    impactText: ["Endpoint under remote control", "Credentials possibly harvested from the browser"],
  },
  {
    key: "cloud_misconfiguration", count: 14, sev: [["medium", 3], ["high", 4], ["critical", 1]], playbook: "Cloud misconfiguration",
    iocTypes: ["url", "ip"], assets: ["export-bucket", "k8s-node-01", "payments-api", "db-prod-01"], containable: 0.3,
    titles: ["Publicly listable storage bucket", "Access key committed to a public repository", "Database snapshot shared publicly"],
    openings: [
      "A storage container holding customer export files was configured to allow public listing.",
      "Secret scanning found a cloud access key in a public code repository.",
      "An external researcher reported that a database snapshot was shared with all accounts.",
    ],
    details: [
      "Access logs show downloads from {ioc}, which is not one of ours.",
      "The key had administrator rights and was valid for {h} hours after the commit.",
      "The setting was changed during a migration and never reverted.",
      "The public link {ioc} had been indexed by a search engine.",
    ],
    impacts: [
      "Sample files were downloaded by the researcher only.",
      "The key was used to list resources but not to change them.",
      "No access other than our own was found in the logs.",
    ],
    linkNotes: ["External downloader", "Public object link"],
    investigation: ["Reviewed access logs for the resource.", "Listed every action taken with the exposed key."],
    containment: ["Removed public access and rotated the key."],
    resolution: ["Policy guardrail added to block public buckets.", "Pre-commit secret scanning enabled."],
    impactText: ["Storage exposed to the internet", "Credentials leaked publicly"],
  },
  {
    key: "ddos", count: 14, sev: [["medium", 3], ["high", 4], ["critical", 1]], playbook: "DDoS mitigation",
    iocTypes: ["ip"], assets: ["customer-portal", "fw-edge-01", "vpn-gw-01", "payments-api"], containable: 0.9,
    titles: ["Volumetric attack on {asset}", "Customer portal unavailable under load", "SYN flood against the edge firewall"],
    openings: [
      "The customer portal became unreachable for several minutes during peak hours.",
      "The edge firewall reported connection tables close to their limit.",
      "Monitoring showed inbound traffic at many times its usual level for {asset}.",
    ],
    details: [
      "Most of the traffic came from a few networks, including {ioc}.",
      "The requests were small and arrived from thousands of addresses at once.",
      "The attack shifted between ports when one was filtered.",
      "An extortion email arrived an hour earlier threatening exactly this.",
    ],
    impacts: [
      "The service was degraded for about {h} hours.",
      "Upstream scrubbing absorbed the traffic within minutes.",
      "Some customers could not complete payments during the attack.",
    ],
    linkNotes: ["Attack source network", "Reflector"],
    investigation: ["Analysed traffic samples to classify the attack.", "Confirmed no intrusion accompanied the flood."],
    containment: ["Upstream scrubbing engaged and edge rate limits applied."],
    resolution: ["Traffic back to normal; thresholds tuned.", "Runbook updated with the provider's contact."],
    impactText: ["Service availability degraded", "Edge capacity exhausted"],
  },
];

const DEPTS = ["Finance", "HR", "Engineering", "Sales", "Operations", "Legal", "Marketing", "IT"];
const DOMAIN_WORDS = ["secure", "verify", "account", "login", "update", "portal", "cloud", "docs", "invoice", "support", "cdn", "sync", "auth", "files", "mail", "pay", "billing", "track", "share", "status"];

export interface DemoLabels {
  generator: string;
  seed: number;
  note: string;
  incidents: Array<{ incident_id: number; family: string; campaign: string | null; chain: string | null }>;
}

interface PlannedIncident {
  family: Family;
  created: Ts;
  campaign: string | null;
  chain: string | null;
  iocs: number[];
  assets: number[];
}

export function buildDemoSeed(): { sql: string; labels: DemoLabels } {
  const r = prng(DEMO_SEED);
  const assetId = new Map(ASSETS.map(([name], i) => [name, i + 1]));

  // ---- IOC registry (unique values, documentation-reserved ranges)
  const iocs: Array<{ id: number; type: IocType; value: string; threat: string; firstSeen?: Ts }> = [];
  const used = new Set<string>();
  const ipPools = ["192.0.2", "198.51.100", "203.0.113"];
  const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[r.int(0, 15)]).join("");
  const domain = () => `${r.pick(DOMAIN_WORDS)}-${r.pick(DOMAIN_WORDS)}${r.int(1, 99)}.${r.chance(0.7) ? "example" : "invalid"}`;
  const newIocValue = (type: IocType): string => {
    switch (type) {
      case "ip": return `${r.pick(ipPools)}.${r.int(1, 254)}`;
      case "domain": return domain();
      case "file_hash": return hex(64);
      case "email": return `${r.pick(["billing", "ceo.office", "payments", "it-support", "hr-team", "noreply"])}@${domain()}`;
      case "url": return `https://${domain()}/${r.pick(["login", "verify", "doc", "invoice", "s", "upload"])}/${hex(8)}`;
    }
  };
  const newIoc = (type: IocType, sev: Sev): number => {
    let v = newIocValue(type);
    while (used.has(`${type}:${v}`)) v = newIocValue(type);
    used.add(`${type}:${v}`);
    const threat = sev === "critical" ? "critical" : sev === "high" ? r.pick(["high", "critical"]) : sev === "medium" ? r.pick(["medium", "high"]) : r.pick(["low", "medium"]);
    iocs.push({ id: iocs.length + 1, type, value: v, threat });
    return iocs.length;
  };

  // ---- plan incidents: campaigns + singletons per family
  const span = HORIZON.getTime() - START.getTime() - 3 * 86_400_000;
  const planned: PlannedIncident[] = [];
  let campaignNo = 0;
  for (const fam of FAMILIES) {
    let left = fam.count;
    const campaigns = Math.max(1, Math.round(fam.count / 9));
    for (let c = 0; c < campaigns && left > 2; c++) {
      const size = Math.min(left, r.int(2, 6));
      left -= size;
      const label = `${fam.key}#${++campaignNo}`;
      const sev = r.weighted(fam.sev);
      const shared = Array.from({ length: r.int(1, 2) }, () => newIoc(r.pick(fam.iocTypes), sev));
      const sharedAsset = r.chance(0.5) ? assetId.get(r.pick(fam.assets))! : null;
      const start = START.getTime() + r.next() * (span - 36 * 86_400_000); // leave room for the campaign's 35-day window
      for (let k = 0; k < size; k++) {
        const created = new Date(start + r.int(0, 35) * 86_400_000 + r.int(7 * 60, 19 * 60) * 60_000);
        const own = r.chance(0.5) ? [newIoc(r.pick(fam.iocTypes), sev)] : [];
        const assets = new Set<number>([assetId.get(r.pick(fam.assets))!]);
        if (sharedAsset !== null && r.chance(0.7)) assets.add(sharedAsset);
        // every member carries the campaign's primary IOC (so membership is evidenced by a COMMON indicator), most carry
        // the secondary one too, and half have an IOC of their own
        const mine = [shared[0]!, ...shared.slice(1).filter(() => r.chance(0.8))];
        planned.push({ family: fam, created: clampDay(created), campaign: label, chain: null, iocs: [...mine, ...own], assets: [...assets] });
      }
    }
    for (let k = 0; k < left; k++) {
      const sev = r.weighted(fam.sev);
      const created = new Date(START.getTime() + r.next() * span);
      created.setUTCHours(r.int(6, 20), r.int(0, 59), 0, 0);
      const n = r.weighted([[0, 1], [1, 5], [2, 3]] as const);
      planned.push({ family: fam, created: clampDay(created), campaign: null, chain: null, iocs: Array.from({ length: n }, () => newIoc(r.pick(fam.iocTypes), sev)), assets: [assetId.get(r.pick(fam.assets))!] });
    }
  }
  for (const p of planned) p.iocs = [...new Set(p.iocs)];

  // ---- cross-family chains: macro malware -> beaconing -> exfiltration sharing one C2 domain
  const byFam = (k: string) => planned.filter((p) => p.family.key === k && p.campaign === null).sort((a, b) => +a.created - +b.created);
  const [mal, c2, exf] = [byFam("malware_macro"), byFam("c2_beaconing"), byFam("data_exfiltration")];
  if (Math.min(mal.length, c2.length, exf.length) < 3) throw new Error("generator bug: not enough singleton incidents for 3 chains");
  const spread = <T>(xs: T[], n: number) => xs[Math.floor((xs.length * n) / 4)]!; // n = 1..3: early, middle, late
  for (let n = 1; n <= 3; n++) {
    const a = spread(mal, n); const b = spread(c2, n); const c = spread(exf, n);
    // place the chain within a few days, in kill-chain order, starting from the malware incident
    b.created = clampDay(minutes(a.created, r.int(1, 4) * 1440 + r.int(0, 300)));
    c.created = clampDay(minutes(b.created, r.int(1, 6) * 1440 + r.int(0, 300)));
    const shared = newIoc("domain", "high");
    for (const p of [a, b, c]) { p.chain = `chain#${n}`; p.iocs = [...new Set([...p.iocs, shared])]; }
  }

  planned.sort((a, b) => +a.created - +b.created || a.family.key.localeCompare(b.family.key));

  // IOC first_seen: a little before the first incident that references it.
  planned.forEach((p) => p.iocs.forEach((id) => {
    const ioc = iocs[id - 1]!;
    if (!ioc.firstSeen || p.created < ioc.firstSeen) ioc.firstSeen = minutes(p.created, -r.int(30, 72 * 60));
  }));

  // ---- emit
  const s = new ReplayScript([
    "SYNTHETIC DATA. GENERATED by scripts/generate-seed.ts (deterministic, seed " + DEMO_SEED + "); do not edit by hand.",
    `Demo dataset: ${planned.length} incidents between ${fmt(START)} and ${fmt(HORIZON)} UTC, replayed through the real`,
    "lifecycle procedures and triggers (docs/DECISIONS.md ADR-2). Ground-truth labels: db/seed/demo_labels.json (never loaded).",
    "Identifiers are documentation-reserved only (RFC 5737 IPs, .example/.invalid domains, random hashes).",
    "password_hash is deliberately NOT a valid hash, so these accounts cannot log in (real auth arrives in M3).",
    "Load into an EMPTY, freshly migrated database: npm run db:reset && npm run db:seed -- demo",
  ]);
  s.raw("INSERT INTO Users (user_id, name, email, password_hash, role, created_at) VALUES");
  s.raw(USERS.map((u) => `  (${u.id}, ${q(u.name)}, ${q(u.email)}, '!SEED-NO-LOGIN!', '${u.role}', '${u.id === 11 ? "2026-09-24 09:00:00" : "2026-01-02 09:00:00"}')`).join(",\n") + ";");
  s.raw("INSERT INTO Assets (asset_id, asset_name, asset_type, ip_address, criticality_level, owner_department) VALUES");
  s.raw(ASSETS.map(([n, t, ip, c, d], i) => `  (${i + 1}, ${q(n)}, '${t}', '${ip}', ${c}, ${q(d)})`).join(",\n") + ";");
  s.raw("INSERT INTO Playbooks (playbook_id, name, applicable_incident_type, steps_description, created_by) VALUES");
  s.raw(PLAYBOOKS.map(([n, t, st], i) => `  (${i + 1}, ${q(n)}, ${q(t)}, ${q(st)}, ${ADMINS[i % 2]})`).join(",\n") + ";");
  s.raw("INSERT INTO IOCs (ioc_id, ioc_type, ioc_value, first_seen, threat_level) VALUES");
  s.raw(iocs.map((c) => `  (${c.id}, '${c.type}', ${q(c.value)}, '${fmt(c.firstSeen ?? START)}', '${c.threat}')`).join(",\n") + ";");

  const playbookId = new Map(PLAYBOOKS.map(([n], i) => [n, i + 1]));
  const load = new Map<number, number>(WORKING_ANALYSTS.map((a) => [a, 0]));
  const leastLoaded = (exclude?: number) => {
    const c = WORKING_ANALYSTS.filter((a) => a !== exclude);
    const min = Math.min(...c.map((a) => load.get(a)!));
    return r.pick(c.filter((a) => load.get(a)! <= min + 1));
  };
  const labels: DemoLabels = {
    generator: "scripts/generate-seed.ts", seed: DEMO_SEED,
    note: "Ground truth for evaluation (M4). Written by the same author as the data: use only with queries written and fixed separately, before any method is run.",
    incidents: [],
  };

  planned.forEach((p, idx) => {
    const id = idx + 1;
    const f = p.family;
    const sev = r.weighted(f.sev);
    const dept = r.pick(DEPTS);
    const fill = (t: string) => t
      .replace(/\{dept\}/g, dept).replace(/\{n\}/g, String(r.int(3, 60))).replace(/\{h\}/g, String(r.int(2, 30)))
      .replace(/\{asset\}/g, ASSETS[p.assets[0]! - 1]![0]);
    const iocText = p.iocs.length ? iocs[p.iocs[0]! - 1]!.value : null;
    const detailPool = f.details.filter((d) => iocText !== null || !d.includes("{ioc}"));
    const details = r.shuffle([...detailPool]).slice(0, r.int(1, 2)).map((d) => fill(d).replace(/\{ioc\}/g, iocText ?? ""));
    const narrative = [fill(r.pick(f.openings)), ...details, fill(r.pick(f.impacts))].join(" ");
    const title = fill(r.pick(f.titles));
    const reporter = r.chance(0.85) ? r.pick(WORKING_ANALYSTS) : r.pick(ADMINS);
    labels.incidents.push({ incident_id: id, family: f.key, campaign: p.campaign, chain: p.chain });

    s.comment(`incident ${id} (${f.key}${p.campaign ? `, ${p.campaign}` : ""}${p.chain ? `, ${p.chain}` : ""})`);
    let t = p.created;
    const step = (lo: number, hi: number) => (t = minutes(t, r.int(Math.round(lo), Math.round(hi))));
    const before = (x: Ts) => x <= HORIZON;
    s.createIncident({ id, title, narrative, severity: sev, reportedBy: reporter, at: t });

    // evidence registered by the reporter
    step(2, 25);
    for (const ioc of p.iocs) s.linkIoc(reporter, t, id, ioc, r.pick(f.linkNotes));
    const pendingImpact = new Set<number>();
    for (const a of p.assets) {
      const known = r.chance(0.5);
      s.linkAsset(reporter, t, id, a, known ? r.pick(f.impactText) : null);
      if (!known) pendingImpact.add(a);
    }
    // ~5%: the reporter also links an IOC from an unrelated incident; usually unlinked later (audited), else dismissed.
    const candidates = iocs.filter((c) => !p.iocs.includes(c.id) && c.firstSeen !== undefined && c.firstSeen <= t);
    const unrelated = r.chance(0.05) && candidates.length > 0 ? r.pick(candidates).id : null;
    let unrelatedLinked = false;
    if (unrelated !== null) { s.linkIoc(reporter, t, id, unrelated, "Possibly related (to confirm)"); unrelatedLinked = true; }

    // how far this incident gets, by age at the horizon
    const ageDays = (HORIZON.getTime() - p.created.getTime()) / 86_400_000;
    const target = ageDays > 45
      ? r.weighted([["closed", 86], ["resolved", 7], ["contained", 3], ["investigating", 4]] as const)
      : ageDays > 15
        ? r.weighted([["closed", 50], ["resolved", 25], ["contained", 10], ["investigating", 10], ["open", 5]] as const)
        : r.weighted([["closed", 12], ["resolved", 18], ["contained", 15], ["investigating", 33], ["open", 22]] as const);
    const triageMin = { critical: [5, 40], high: [15, 150], medium: [30, 600], low: [60, 1800] }[sev] as [number, number];
    const workMin = { critical: [240, 2400], high: [600, 5000], medium: [1200, 9000], low: [2400, 16000] }[sev] as [number, number];

    // the newest few reports arrived just before "now" and have not been triaged yet (always present in the demo)
    const untriaged = idx >= planned.length - 3;
    if (untriaged || (target === "open" && r.chance(0.5))) return;
    step(...triageMin); if (!before(t)) return;
    let assignee = leastLoaded();
    load.set(assignee, load.get(assignee)! + 1);
    const admin = r.pick(ADMINS);
    s.reassign(admin, t, id, assignee, r.pick(["Triage", "Triage: on shift", "Triage: matches recent work", `Triage: ${sev} severity`]));
    if (target === "open") return;

    step(5, 90); if (!before(t)) return;
    s.transition(assignee, t, id, "investigating");
    if (r.chance(0.7)) { step(5, 60); if (!before(t)) return; s.applyPlaybook(t, id, playbookId.get(f.playbook)!); }
    for (const n of r.shuffle([...f.investigation]).slice(0, r.int(1, 2))) { step(20, 400); if (!before(t)) return; s.note(assignee, t, id, n); }
    if (unrelated !== null && r.chance(0.8)) { step(10, 200); if (!before(t)) return; s.unlinkIoc(assignee, t, id, unrelated); unrelatedLinked = false; }

    if (r.chance(0.12)) { // handover
      step(60, 1440); if (!before(t)) return;
      const next = leastLoaded(assignee);
      s.reassign(r.pick(ADMINS), t, id, next, r.pick(["Shift handover", "Rebalancing workload", "Needs cloud expertise", "Analyst on leave"]));
      load.set(next, load.get(next)! + 1);
      assignee = next;
    }
    if (target === "investigating") return;

    const contains = target === "contained" || r.chance(f.containable);
    if (contains) {
      step(workMin[0] / 3, workMin[1] / 3); if (!before(t)) return;
      s.note(assignee, t, id, r.pick(f.containment));
      s.transition(assignee, t, id, "contained");
      if (target !== "contained" && r.chance(0.05)) {
        step(120, 2000); if (!before(t)) return;
        s.transition(assignee, t, id, "investigating", "Activity resumed after containment");
        step(120, 2000); if (!before(t)) return;
        s.transition(assignee, t, id, "contained");
      }
    }
    if (target === "contained") return;

    // review evidence, then resolve
    step(workMin[0] / 2, workMin[1] / 2); if (!before(t)) return;
    for (const ioc of p.iocs) s.reviewIoc(assignee, t, id, ioc, r.chance(0.12) ? "dismissed" : "confirmed");
    if (unrelatedLinked) s.reviewIoc(assignee, t, id, unrelated!, "dismissed");
    for (const a of pendingImpact) s.describeImpact(assignee, t, id, a, r.pick(f.impactText));
    step(10, 240); if (!before(t)) return;
    s.note(assignee, t, id, r.pick(f.resolution));
    s.transition(assignee, t, id, "resolved");
    if (target === "resolved") return;

    step(240, 4300); if (!before(t)) return;
    const closer = r.pick(ADMINS);
    s.close(closer, t, id, r.pick(["Reviewed and closed", "Evidence complete; closing", "Closed after review", null]));

    if (r.chance(0.06)) { // reopened after closure
      step(1440, 10000); if (!before(t)) return;
      s.transition(closer, t, id, "investigating", r.pick(["Same indicator seen again", "User reported further symptoms", "Root cause not confirmed"]));
      step(240, 3000); if (!before(t)) return;
      s.note(assignee, t, id, "Re-checked after reopening: " + r.pick(f.investigation).toLowerCase());
      step(60, 1500); if (!before(t)) return;
      s.transition(assignee, t, id, "resolved");
      step(240, 3000); if (!before(t)) return;
      s.close(r.pick(ADMINS), t, id, "Closed again after re-investigation");
    }
    if (p.created < new Date("2026-04-01T00:00:00Z") && r.chance(0.18)) {
      const at = minutes(ARCHIVE_DAY, idx);
      if (at > t && before(at)) s.archive(1, at, id, "Retention review Q3: closed more than 90 days");
    }
  });

  return { sql: s.toString(), labels };
}

/** Keeps generated timestamps inside the dataset window. */
function clampDay(t: Ts): Ts {
  if (t < START) return new Date(START.getTime() + 8 * 3_600_000);
  const latest = new Date(HORIZON.getTime() - 6 * 3_600_000);
  return t > latest ? latest : t;
}

export default {
  common: {
    cancelled: 'Cancelled.',
    notConfirmed: 'Not confirmed.',
    yes: 'yes',
    no: 'no',
    none: '(none)',
    unknown: 'unknown',
    dash: '—',
    noRecords: '  (no records)',
    typeToConfirm: 'Type the application folder name to continue',
    mustType: 'You must type "{expected}".',
    noProfile: 'No cPanel profile saved.',
    runLogin: 'Run "deploymanager login" first.',
  },

  cli: {
    unknownCommand: 'Unknown command: {name}',
    tryHelp: 'Try "deploymanager --help".',
    optionsHint: 'Run "deploymanager --help" to see the options.',
    help: `
  cpanel-next — deploy Next.js projects to cPanel

  USAGE
    deploymanager [command] [options]

  COMMANDS
    (no command)      Deploy the project in the current directory, interactively
    deploy            Same, with flags (can run non-interactively)
    login             Connect to cPanel and create an API token for this tool
    logout            Remove the saved profile (and its token)
    status            Resolve a domain and show the account's Node.js apps
    apps              List every Node.js app on the account
    rollback          Restore a previous release
    logs              Show the server output of the last run
    doctor            Check connectivity, capabilities and environment
    ui                Open the local web interface (manage from a browser)
    config            Default interface and language settings
    maintenance       Turn the maintenance page on/off (on|off|status)

  OPTIONS
    --host <name>            cPanel server (e.g. server.com)
    --user <name>            cPanel username
    --token <token>          cPanel API token (read from the profile if omitted)
    --port <n>               cPanel port (default 2083)
    --profile <name>         Saved profile name
    --password-stdin         Read the password from stdin (for CI)
    --insecure               Skip TLS certificate verification (for mismatched
                             certificates; only on a server you trust)

    --domain <domain>        Domain or subdomain to deploy to
    --app-root <folder>      Application folder on the server (home-relative)
    --app-name <name>        Application name (defaults to app-root)
    --node-version <n>       Node version (selectable on CloudLinux only)
    --no-build               Skip "npm run build" (ships the existing .next)
    --clean-modules          Delete node_modules on the server and reinstall
    --transport <way>        upload | ftp  (default: automatic)

    --lang <tr|en>           Interface language
    --web / --terminal       Pick the interface for this run (overrides preference)
    --no-open                (ui) do not open the browser automatically
    -y, --yes                Skip confirmations (destructive steps still ask)
        --confirm <name>     Confirm a destructive step: pass the exact app-root
                             (for non-interactive use; replaces typed confirmation)
        --dry-run            Write nothing, print what would happen
        --force              Bypass the protected-name check (ownership still enforced)
        --adopt              Adopt an app this tool did not create
    -v, --verbose            Verbose output
    -h, --help               This help
        --version            Version

  EXAMPLES
    cd ~/projects/shop && deploymanager
    deploymanager --domain shop.example.com --app-root shopnext -y
    deploymanager status --domain shop.example.com
    deploymanager --dry-run
`,
  },

  config: {
    loosePerms: 'Permissions on {file} were too open ({mode}); tightened to 0600.',
    readFailed: 'Could not read the configuration file ({file}): {error}',
    projectReadFailed: 'Could not read {file}: {error}',
    secretInProject:
      '{file} contains what looks like a secret: "{path}".\n' +
      'This file is meant to be committed; tokens and passwords belong in ~/.cpanel-next/config.json.\n' +
      'Remove the field and try again.',
  },

  config: {
    title: 'cpanel-next · settings',
    current: 'Current settings',
    labelFile: 'File',
    labelProfiles: 'Profiles',
    labelUi: 'Interface',
    labelLang: 'Language',
    notSet: 'not set',
    auto: 'automatic (system language)',
    askUi: 'Which interface should be the default?',
    uiTerminal: 'Terminal',
    uiTerminalHint: 'guided command-line flow',
    uiWeb: 'Web interface',
    uiWebHint: 'opens a browser; the terminal waits until you close it',
    askLang: 'Language',
    saved: 'Settings saved.',
    uiSaved: 'Default interface: {mode}',
    langSaved: 'Language: {lang}',
    unknownSetting: 'Unknown setting: {key} {value}',
    firstRun: 'First run — asking this once.',
    changeLater: 'To change it later: deploymanager config',
  },

  maintenance: {
    title: 'cpanel-next · maintenance page',
    usage: 'Usage: deploymanager maintenance on|off|status [--domain <d>]',
    which: 'Which domain?',
    noDocroot: 'No document root found for "{domain}".',
    checking: 'Reading state',
    turningOn: 'Turning on the maintenance page',
    turningOff: 'Turning off the maintenance page',
    isOn: 'Maintenance page is ON — visitors see "updating"',
    isOff: 'Maintenance page is off — the site is live',
    labelDomain: 'Domain',
    labelDocroot: 'Document root',
  },

  cpanel: {
    noHost: 'No cPanel server specified.',
    loginHint: 'Connect with "deploymanager login".',
    noToken: 'No cPanel API token found.',
    noTokenHint: 'Run "deploymanager login"; the tool will create one for you.',
    authRejected: 'cPanel rejected the credentials ({label}, HTTP {status}).',
    authRejectedToken:
      'The token may be invalid or revoked. Refresh it with "deploymanager login".',
    authRejectedSession: 'The session may have expired; you will be asked for the password again.',
    api2Rejected: 'cPanel API2 rejected the credentials ({label}, HTTP {status}).',
    api2RejectedHint: 'The token may not be accepted on API2 endpoints; trying session mode.',
    api2Unexpected: 'cPanel API2 returned an unexpected response ({label}, HTTP {status}).',
    htmlResponse: 'cPanel returned HTML instead of JSON ({label}, HTTP {status}).',
    htmlResponseHint: 'The host or port may be wrong, or the session may have expired.',
    parseFailed: 'Could not parse the cPanel response ({label}, HTTP {status})',
    requestFailed: '{label}: request failed (status={status})',
    timeout: 'Timed out after {seconds}s: {host}',
    aborted: 'Aborted',
  },

  vault: {
    corrupt: 'The vault data is corrupt.',
    corruptHint: 'Reset it with "deploymanager logout" and connect again.',
    wrongPassword: 'Wrong master password.',
    wrongPasswordHint:
      'If you forgot it, remove the profile with "deploymanager logout" and connect again.',
    inVault: 'in vault',
    plaintext: 'unencrypted — legacy format',
  },

  auth: {
    masterPrompt: 'Master password',
    masterRequired: 'Master password is required.',
    masterCreateInfo:
      'The cPanel token stored on this device will be encrypted with a master password.\n' +
      'The password is never written anywhere — if you FORGET it, the stored data\n' +
      'cannot be opened and you will have to connect again. There are no complexity rules.',
    masterNew: 'Choose a master password',
    masterNewRequired: 'Master password cannot be empty.',
    masterRepeat: 'Repeat the master password',
    masterMismatch: 'The passwords do not match.',
    masterWrongRetry: 'Wrong master password, try again.',
    tokenEncryptedNoVault: 'The stored token is encrypted but there is no vault data.',
    tokenEncryptedNoVaultHint: 'Reconnect with "deploymanager login".',
    passwordPrompt: 'cPanel password',
    passwordFor: 'cPanel password for {user}@{host}',
    passwordRequired: 'Password cannot be empty.',
    tfaPrompt: 'Two-factor authentication code',
    tfaInvalid: 'Enter the 6-digit code.',
    tfaRequired: 'This account has two-factor authentication enabled.',
    tfaEnterCode: 'Enter the verification code.',
    sessionFailed: 'Could not open a cPanel session.',
    loginRejected: 'Login rejected',
    loginFailed: 'cPanel login failed: {message}',
    noJson: 'cPanel login did not return JSON (HTTP {status}).',
    noJsonHint: 'Are the host and port correct? If there is a custom login page, the browser path will be tried.',
    noSecurityToken: 'Could not obtain the cPanel session token (cpsess).',
    browserLoginFailed: 'Browser login failed (no cpsess returned).',
    browserLoginHint: 'The password or verification code may be wrong.',
    tokenFeatureDisabled: 'API tokens (apitokens) are disabled on this account.',
    tokenFeatureDisabledHint:
      'That is fine — the tool will use session mode and ask for your password each run.',
    tokenMissingInResponse: 'cPanel created a token but none was returned in the response.',
    tokenFailed: 'Could not create an API token.',
    escalating: 'This step cannot be done with the API token{reason}; opening a cPanel session.',
  },

  browser: {
    playwrightMissing: 'Could not load playwright-core.',
    playwrightHint: 'Try reinstalling: npm i -g cpanel-next  ({error})',
    installerMissing: 'Chromium installer not found (playwright-core/cli.js).',
    installerHint:
      'You can install it manually: PLAYWRIGHT_BROWSERS_PATH={dir} npx playwright-core install chromium',
    downloading: 'Downloading Chromium (~150 MB, one time)',
    ready: 'Chromium ready',
    downloadFailed: 'Chromium download failed (exit code {code}).',
    needsBrowser:
      'This step needs a browser{reason}.\n' +
      'Chromium (~150 MB) will be downloaded into {dir}.\n' +
      'It will not be downloaded again.',
    askDownload: 'Download Chromium?',
    refused: 'This step cannot be completed without a browser.',
    refusedHint: 'The API path was not enough on this server. Allow it and the browser path will be tried.',
    sessionReason: 'cPanel session',
  },

  detect: {
    noPackageJson: 'No package.json here — this does not look like a Next.js project.',
    laravelNotSupported: 'Laravel is not supported yet (phase 2). Only Next.js can be deployed for now.',
    packageJsonUnreadable: 'Could not read package.json: {error}',
    mixedProject:
      'This directory has both Laravel (artisan) and Next.js (package.json). ' +
      'It is ambiguous which one to deploy — cd into the Next.js project folder and try again.',
    noNextDep: 'package.json has no "next" dependency.',
    noBuildScript: 'package.json has no "build" script.',
    buildScriptOdd: 'The build script does not run "next build": "{script}"',
    standalone:
      "next.config sets output: 'standalone'. Passenger requires a custom server.js, and Next's own " +
      'documentation says the two cannot be used together. Phase 1 does not support this — ' +
      'remove standalone or wait for the next release.',
    next134:
      'Next.js {version} does not work under Passenger: router-server opens a second http.Server, ' +
      'producing "http.Server.listen() was called more than once". ' +
      'Upgrade to 13.5.6 or later.',
    esmWarning:
      'package.json sets "type": "module". Passenger cannot load ESM, so the startup file ' +
      'will be created as server.cjs.',
    noLockfile:
      'No lockfile. Dependencies will be installed unpinned on the server, ' +
      'which may produce a different tree than your local one.',
    oldNode: 'Local Node {version} is old; packaging may misbehave.',
    nativeDeps:
      'Native dependencies will be compiled on the server: {list}. ' +
      'Compilation can fail on older glibc such as CloudLinux 7.',
    sharpOptional:
      'Next 15+ moved sharp to optionalDependencies. If the server skips optional packages, ' +
      'image optimization breaks silently; add sharp as a direct dependency if you hit this.',
    basePath:
      'next.config sets basePath. basePath is baked in at build time; the app must be served at the ' +
      'domain root (base_uri "/") or the paths will not resolve.',
  },

  domain: {
    listFailed: 'Could not list the account domains: {error}',
    listFailedHint: 'Can the token/session reach this account?',
    empty: 'Domain cannot be empty.',
    parked:
      'Parked domains have no document root of their own; they redirect to the main domain. ' +
      'Use a subdomain or an addon domain instead.',
    invalidLabel: 'Invalid subdomain label: {label}',
    types: {
      main: 'main domain',
      addon: 'addon domain',
      sub: 'subdomain',
      parked: 'parked',
    },
  },

  guards: {
    emptyAppRoot: 'The application folder (app-root) cannot be empty.',
    invalidAppRoot: 'Invalid application folder: "{name}"',
    invalidAppRootHint:
      'Use only letters, digits, dot, underscore and hyphen; no slashes and no "..".',
    dotStart: 'The application folder cannot start with a dot: "{name}"',
    dotStartHint: 'Dot-prefixed directories belong to the account\'s own configuration.',
    protected: '"{name}" is a protected folder and cannot be used as an application folder.',
    protectedHint:
      'Next.js source must not live inside a document root or the account infrastructure. Pick a separate folder name.',
    protectedForce: '"{name}" is protected and is not unlocked even by --force.',
    protectedForceHint: 'Deleting this folder would break the account.',
    docrootClash: '"{name}" is the document root of a domain ({docroot}).',
    docrootClashHint:
      'The application folder must be SEPARATE from the document root; otherwise your source code ' +
      'and .env file become publicly reachable. Pick a different name (e.g. "{suggestion}").',
    notOwned: '"{appRoot}" was not created by this tool (no ownership marker).',
    notOwnedHint:
      'Its contents were about to be deleted and replaced — stopped.\n' +
      'If you are certain this is your application, add --adopt; you will be asked to type the ' +
      'folder name on the confirmation screen.',
    newFolder: 'new folder',
  },

  packager: {
    buildStartFailed: 'Could not start the build: {error}',
    buildStartHint: 'Is {cmd} installed and on PATH?',
    buildFailed: 'Build failed (exit code {code}).',
    noBuildId: '.next/BUILD_ID was not created — the build produced no output.',
    noBuildIdHint: 'Does your build script actually run "next build"?',
    staleBuildId: '.next/BUILD_ID was not updated — the build seems to have produced nothing new.',
    staleBuildIdHint: 'Use --no-build if you deliberately want to ship the existing output.',
  },

  remote: {
    deleteFailed: 'Could not delete: {path}',
    deleteFailedHint: 'The cPanel delete call reported success but the file is still there.',
  },

  transport: {
    failed: 'Could not transfer the package to the server.',
    rejected: 'Upload rejected: {reason}',
    unknownReason: 'unknown reason',
    missingAfterUpload: 'The upload reported success but the file is not on the server.',
    ftpMissing: 'basic-ftp is not installed; skipping the FTP path.',
    ftpCleanupFailed:
      'Could not remove the temporary FTP account "{user}". Delete it manually in cPanel → FTP Accounts.',
    splitting: 'Splitting the package into {count} parts (the host rejected a single upload).',
  },

  driver: {
    quotaFull: 'Application quota is full ({current}/{max}).',
    quotaFullHint: 'Remove an unused application in cPanel → Application Manager.',
    depsFailed: 'Dependency installation failed: {message}',
    depsTimeout: 'Dependency installation timed out.',
  },

  cron: {
    notTriggered: '{label}: cron has not fired for 2.5 minutes.',
    notTriggeredHint: 'Your hosting provider may be restricting cron jobs.',
    failed: '{label} failed: {error}',
    unknownError: 'unknown error',
    timeout: '{label}: timed out after {minutes} min.',
    appLabel: 'Node.js application',
    depsLabel: 'Dependency installation',
    stopLabel: 'Stop',
    startLabel: 'Start',
  },

  login: {
    title: 'cpanel-next · connect',
    askHost: 'cPanel server',
    askHostRequired: 'Server name is required.',
    askUser: 'cPanel username',
    askUserRequired: 'Username is required.',
    opening: 'Opening a cPanel session',
    openFailed: 'Could not open a session',
    opened: 'Session opened ({via})',
    viaHttp: 'direct',
    viaBrowser: 'browser',
    creatingToken: 'Creating an API token for this tool',
    tokenCreated: 'Token created: {name}',
    tokenDisabled: 'API tokens are disabled — session mode will be used',
    tokenFailed: 'Could not create a token',
    verifying: 'Verifying the token',
    verified: 'Token works',
    verifyFailed: 'Could not verify the token',
    verifyFailedMessage: 'The token that was created was rejected: {error}',
    verifyFailedHint:
      'Your host may restrict token access. The tool can still work in session mode.',
    savedTitle: 'Profile saved',
    labelServer: 'Server',
    labelAccount: 'Account',
    labelToken: 'Token',
    labelStore: 'Stored',
    labelQuota: 'App quota',
    noTokenValue: 'none — you will be asked for the password each run',
    tokenScopeWarning:
      'cPanel API tokens cannot be scoped: this token can reach everything your\n' +
      'account can reach. You can delete the "{name}" entry any time from\n' +
      'cPanel → Security → Manage API Tokens.',
    passwordNotStored: 'Your password was not written anywhere.',
    done: 'Ready. cd into a Next.js project and run {command}.',
  },

  logout: {
    title: 'cpanel-next · logout',
    noProfiles: 'No saved profiles.',
    which: 'Which profile should be removed?',
    notFound: 'Profile not found: {name}',
    confirm: 'Remove the profile {user}@{host}?',
    removed: 'Profile removed.',
    tokenStillValid:
      'The API token on the server is still valid: {name}\n' +
      'To revoke it entirely, delete it in cPanel → Security → Manage API Tokens.',
  },

  apps: {
    title: 'cpanel-next · applications',
    noManager: 'No Node.js application management was found on this account.',
    reading: 'Reading applications',
    count: '{count} application(s)',
    emptyTitle: '{user}@{host}',
    empty:
      'There are no Node.js applications on this account.\n' +
      'cd into a Next.js project and run "deploymanager" to create the first one.',
    headers: ['APPLICATION', 'DOMAIN', 'NODE', 'STATUS', 'FOLDER', 'OWNER'],
    ownerSelf: 'cpanel-next',
    ownerExternal: 'external',
    ownerNote: 'Applications marked "external" were not created by this tool and are never overwritten.',
    quota: 'quota {current}/{max}',
    statusRunning: 'running',
    statusStopped: 'stopped',
  },

  status: {
    title: 'cpanel-next · status',
    reading: 'Reading the account',
    summary: '{domains} domain(s) · {apps} application(s)',
    connectionTitle: 'Connection',
    labelServer: 'Server',
    labelAccount: 'Account',
    labelRegime: 'Regime',
    labelAuth: 'Auth',
    authToken: 'API token',
    authSession: 'session (no token)',
    headers: ['DOMAIN', 'TYPE', 'DOCUMENT ROOT', 'APPLICATION'],
    notFound: '"{domain}" is not on this account and no parent zone was found either.',
    canCreateSub:
      '"{domain}" does not exist yet, but "{root}" is on the account — it can be created as a subdomain during deploy.',
    projectTitle: 'Local project',
    labelDir: 'Directory',
    labelFramework: 'Next.js',
    labelStartup: 'Startup',
    labelState: 'State',
    startupMissing: ' (missing, will be created)',
    deployable: 'deployable',
    notDeployable: 'blocked',
    deployedTitle: 'Deployed with this tool',
  },

  doctor: {
    title: 'cpanel-next · diagnostics',
    envTitle: 'Environment',
    serverTitle: 'Server',
    projectTitle: 'Local project · {dir}',
    nodeNeeds: '18.17 or later required',
    platform: 'Platform {platform} {arch}',
    chromiumInstalled: 'Chromium installed',
    chromiumMissing: 'Chromium not installed',
    chromiumHint: 'downloaded on demand (~150 MB)',
    configAt: 'Configuration {file} ({mode})',
    configMissing: 'No configuration',
    configMissingHint: 'run "deploymanager login"',
    server: 'Server {host}:{port}',
    account: 'Account {user}',
    token: 'Token {value}',
    tokenMissing: 'No token',
    tokenMissingHint: 'session mode will be used',
    uapiOk: 'UAPI connection works',
    uapiFail: 'UAPI connection',
    quota: 'App quota {value}',
    api2Ok: 'API2 (with token) works',
    api2Fail: 'API2 (with token)',
    api2FailHint: '{error} — will fall back to session mode',
    regime: 'Regime: {label}',
    passengerModule: 'PassengerApps module',
    webappModule: 'WebApp API (cPanel 138+)',
    appCount: 'Registered applications: {count}',
    probeFail: 'Capability detection',
    ftp: 'FTP {state}',
    ftpOff: 'disabled',
    ftpHint: 'uploads will use UAPI',
    loginFirst: 'Run "deploymanager login" first to check the server.',
    connectFailed: 'Could not connect.',
    framework: 'Framework: {name}',
    nextInfo: 'Next.js {version} · {router} router',
    startupWillCreate: 'will be created during deploy',
    deployable: 'Deployable',
    notDeployable: 'Not deployable',
  },

  rollback: {
    title: 'cpanel-next · rollback',
    reading: 'Reading backups',
    count: '{count} backup(s)',
    noneTitle: 'No backups found',
    none:
      'There are no backups under ~/{dir}.\n' +
      'Backups are only taken when an existing application is overwritten.',
    noneForApp: 'No backup found for {name}; listing all backups.',
    which: 'Which backup should be restored?',
    notOwned: '~/{appRoot} was not created by this tool.',
    notOwnedHint: 'Rollback stopped. Add --adopt if you are certain.',
    warning:
      'The contents of ~/{appRoot} will be deleted and ~/{backup} restored.\n' +
      'Dependencies will be reinstalled, so this may take 1-2 minutes.',
    working: 'Rolling back',
    maintenanceOn: 'Turning on the maintenance page',
    maintenanceOff: 'Turning off the maintenance page',
    maintenanceRuleFailed: 'Could not install the maintenance page: {error}',
    maintenanceLeftOn:
      'The maintenance page was LEFT ON ({domain}). The site shows "updating".\n' +
      'To turn it off: deploymanager maintenance off --domain {domain}',
    stopping: 'Stopping the application',
    cleaningModules: 'Reinstalling dependencies from scratch (removing node_modules)',
    cleaning: 'Removing current files',
    cleanFailed: 'Some files could not be deleted: {files}',
    restoring: 'Restoring the backup',
    missingPackageJson: 'package.json is missing after restore — the backup may be incomplete.',
    installing: 'Installing dependencies',
    installingCron: 'Installing dependencies (waiting for cron)',
    starting: 'Starting the application',
    doneSpinner: 'Rolled back',
    failed: 'Rollback failed',
    doneTitle: 'Done',
    labelFolder: 'Folder',
    labelBackup: 'Backup',
    labelUrl: 'URL',
    done: 'Rolled back.',
  },

  logs: {
    title: 'cpanel-next · logs',
    reading: 'Reading server runs',
    count: '{count} run record(s)',
    which: 'Which run?',
    none: 'No pending or completed run records on the server.',
    completed: 'Completed',
    failed: 'Failed: {error}',
    running: 'In progress · {progress}% · {step}',
    outputHeader: '--- server output (last 4000 characters) ---',
    markerTitle: 'Ownership marker',
    labelFolder: 'Folder',
    labelDomain: 'Domain',
    labelProject: 'Project',
    labelMachine: 'Machine',
    labelVersion: 'Version',
    labelCreated: 'Created',
    historyHeaders: ['DATE', 'VERSION', 'STATUS'],
    historyOk: 'ok',
    historyFail: 'error',
    needApp: 'Run this inside a project directory or pass --app-root to see the app history.',
  },

  deploy: {
    title: 'cpanel-next',
    dryRunBadge: ' · DRY RUN',
    notDeployable: 'The project cannot be deployed as it is.',
    projectLine: '{framework} · {router} router · {name}',
    probing: 'Checking server capabilities',
    probed: 'Server: {regime}',
    cached: ' (cached)',
    noDriver: 'Node.js applications cannot be managed on this account.',
    noDriverHint:
      'Neither cPanel Application Manager nor CloudLinux Node.js Selector could be found.\n' +
      'Ask your hosting provider whether the "Setup Node.js App" feature is enabled.',
    noDomains: 'No domains found on the account {user}@{host}.',
    domainNotFound: '"{domain}" is not on this account and no parent zone was found either.',
    domainNotFoundHint:
      'Domains on this account:\n  {list}\n\nAdd the domain in cPanel → Domains first.',
    askDomain: 'Which domain should this be deployed to? ({account})',
    newSubdomain: '+ create a new subdomain',
    askRoot: 'Under which domain?',
    askLabel: 'Subdomain label  (… .{root})',
    labelRequired: 'A label is required.',
    labelChars: 'Letters, digits and hyphens only.',
    labelExists: 'That subdomain already exists.',
    appExists: 'This domain already has an application: {name} (~/{path})',
    askUpdate: 'Update "{name}"?',
    askAppRoot: 'Application folder on the server',
    startupCreated: '{file} created (Passenger startup file). Commit it to your project.',
    destructiveWarn: 'The contents of {appRoot} will be DELETED and your package extracted.',
    destructiveWarnPreserve: ' (except preserved files)',
    askPublish: 'Deploy to {url}?',
    creatingSubdomain: 'Creating subdomain: {domain}',
    createdSubdomain: 'Subdomain created: {domain}',
    sslNote:
      'The SSL certificate (AutoSSL) can take up to an hour; a certificate warning until then is normal.',
    building: 'Building the project (npm run build)',
    noBuildFlag: '--no-build: shipping the existing .next output.',
    noBuildOutput: 'No .next/BUILD_ID — there is no build to ship.',
    packing: 'Preparing the package',
    packed: 'Package ready: {files} files · {size}',
    skippedEnv: 'Environment files kept out of the package: {list}',
    backingUp: 'Backing up the current release',
    backedUp: 'Backup: ~/{path}',
    backupFailed: 'Backup failed',
    backupFailedMessage: 'Backup failed: {error}',
    backupFailedHint: 'We do not overwrite a live application without a way back.',
    uploading: 'Uploading the package',
    uploadingProgress: 'Uploading · {sent} / {total}',
    uploaded: 'Package uploaded ({strategy})',
    uploadTooLarge: 'Single upload rejected, splitting',
    uploadFailed: 'Upload failed',
    applying: 'Applying on the server',
    stopping: 'Stopping the application',
    cleaning: 'Removing old files',
    cleanFailed: 'Some files could not be deleted: {files}',
    cleanFailedHint: 'The cPanel delete call may have failed silently; deploy stopped.',
    extracting: 'Extracting the archive',
    missingPackageJson: 'The archive was extracted but package.json is missing.',
    backupKept: 'Backup kept: ~/{path}',
    writingMarker: 'Writing the ownership marker',
    registering: 'Registering the Node.js application',
    runningRemote: 'Running on the server (waiting for cron to fire)',
    installing: 'Installing dependencies (npm install)',
    installingLine: 'Dependencies: {line}',
    restarting: 'Restarting the application',
    published: 'Deployed',
    remoteFailed: 'The server step failed',
    rollbackHint: 'To roll back: deploymanager rollback --domain {domain}',
    doneTitle: 'Done',
    labelUrl: 'URL',
    labelAccount: 'Account',
    labelFolder: 'Folder',
    labelBackup: 'Backup',
    labelRollback: 'Rollback',
    live: 'Live.',
    dryRunDone: '--dry-run: nothing was written.',

    confirmMismatch: '--confirm "{given}" does not match the application folder ("{appRoot}").',
    confirmMismatchHint: 'Pass the exact folder name to confirm a destructive step.',
    confirmedByFlag: 'Confirmed with --confirm: {appRoot}',
    summaryTitle: 'DEPLOY CONFIRMATION',
    summaryTitleDestructive: 'DEPLOY CONFIRMATION · WILL OVERWRITE',
    sLocalProject: 'Local project',
    sFramework: 'Framework',
    sStartup: 'Startup',
    sStartupCreated: ' (created)',
    sServer: 'Server',
    sAccount: 'cPanel account',
    sDomain: 'Domain',
    sNewSubdomain: '  [NEW SUBDOMAIN]',
    sDocroot: 'Document root',
    sDocrootAuto: '(cPanel decides)',
    sApp: 'Application',
    sNew: '  [NEW]',
    sOwner: 'Ownership',
    ownerNew: 'new folder',
    ownerSelf: 'deployed with this tool',
    ownerForeign: 'not created by this tool — will be overwritten',
    ownerOtherDomain: 'BOUND TO ANOTHER DOMAIN: {domain}',
    ownerOtherDomainWarn:
      'CAREFUL: this folder belongs to an application bound to "{domain}". ' +
      'You may have picked the wrong folder.',
    sPackage: 'Package',
    sPackageValue: '{files} files · {size}',
    sUrl: 'URL',
    sEnvExcluded: 'Environment files that will NOT be packaged: {list}',
    sOthers: 'Other applications on this account that will not be touched:',
    excludedTitle: 'Excluded',
    excludedItem: '{count} entries · {size}',
    stepsTitle: 'Plan',
    stepBuild: 'npm run build  (locally)',
    stepZip: 'zip → Fileman::upload_files',
    stepBackup: 'backup: fileop copy  ~/{appRoot} → ~/{dir}/{appRoot}-<timestamp>',
    stepClean: 'clean: fileop unlink  ~/{appRoot}/* (except node_modules, tmp and preserved files)',
    stepExtract: 'fileop extract  → ~/{appRoot}',
    stepMarker: '{file} is written (ownership marker)',
    stepRestart: 'tmp/restart.txt is touched + ~11s wait + HTTP GET to the app',
  },

  probe: {
    webappAvailable: 'WebApp API available (cPanel 138+)',
    passengerResponded: 'PassengerApps responded ({count} applications)',
    venvSeen: 'CloudLinux venv path seen: {path}',
    nodePath: 'Node path: {path}',
    passengerUnavailable: 'PassengerApps unavailable: {error}',
    nodevenvDir: '~/nodevenv directory exists',
    assumedStock: 'No CloudLinux traces; assuming stock cPanel Application Manager',
    featureOn: 'passengerapps feature is on but the list could not be read',
    featureOff: 'passengerapps feature is off',
    selectorApps: 'node-selector.json: {count} applications',
  },

  ui: {
    title: 'cpanel-next · interface',
    running: 'Interface running',
    address: 'Address',
    bound: 'Listening on',
    security:
      'The server is reachable only from this computer (127.0.0.1) and rejects any request ' +
      'without the token in the address. Your cPanel token is never sent to the browser.',
    stop: 'Press Ctrl+C to stop.',
    waiting: 'Browser open — closing it returns you to the terminal (Ctrl+C also works)',
    browserClosed: 'Browser closed, back in the terminal.',
    stopped: 'Interface stopped.',
  },

  regime: {
    cloudlinux: 'CloudLinux Node.js Selector',
    passenger: 'cPanel Application Manager',
    unknown: 'unknown',
  },
};

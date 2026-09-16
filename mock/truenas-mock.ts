import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * A TrueNAS that is not there.
 *
 * Answers the JSON-RPC methods the console calls, from fixtures, over the
 * same WebSocket protocol as the real thing: login, the realtime
 * subscription, jobs, and the shell endpoint. It exists for three reasons.
 * Tests can run the routes against something that speaks the protocol
 * rather than a hand-made object per test. A browser test can sign in, add
 * a server and see a Home page with numbers on it, on a CI runner with no
 * NAS. And anyone can try the console before installing it.
 *
 * It is a demo, not an emulator: writes return plausible ids and change
 * nothing, and methods it does not know get an empty answer and a line in
 * its log, so a new route's needs are discovered by running it once.
 *
 *   npm run mock             ws://127.0.0.1:18443, API key "1-mock"
 *   MOCK_PORT=… npm run mock
 *
 * Or from a test: `const mock = await startMock(0)` and point a TrueNas
 * client at `mock.url`.
 */

export const API_KEY = process.env.MOCK_API_KEY ?? "1-mock";

/* ------------------------------------------------------------ fixtures */

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
const now = Date.now();
const daysAgo = (d: number) => ({ $date: now - d * 86_400_000 });

const disks = [
  {
    name: "sda",
    model: "WDC WD80EFZZ",
    serial: "WD-AA1001",
    size: 8 * TiB,
    type: "HDD",
    rotationrate: 5400,
    pool: "tank",
    temp: 36,
  },
  {
    name: "sdb",
    model: "WDC WD80EFZZ",
    serial: "WD-AA1002",
    size: 8 * TiB,
    type: "HDD",
    rotationrate: 5400,
    pool: "tank",
    temp: 37,
  },
  {
    name: "sdc",
    model: "WDC WD80EFZZ",
    serial: "WD-AA1003",
    size: 8 * TiB,
    type: "HDD",
    rotationrate: 5400,
    pool: "tank",
    temp: 44,
  },
  {
    name: "sdd",
    model: "WDC WD80EFZZ",
    serial: "WD-AA1004",
    size: 8 * TiB,
    type: "HDD",
    rotationrate: 5400,
    pool: "tank",
    temp: 35,
  },
  {
    name: "nvme0n1",
    model: "Samsung 980 PRO",
    serial: "S6B0NL0T",
    size: 1 * TiB,
    type: "SSD",
    rotationrate: null,
    pool: "fast",
    temp: 41,
  },
  {
    name: "nvme1n1",
    model: "Samsung 980 PRO",
    serial: "S6B0NL0U",
    size: 1 * TiB,
    type: "SSD",
    rotationrate: null,
    pool: "fast",
    temp: 42,
  },
  {
    name: "sde",
    model: "Seagate ST4000VN",
    serial: "ZDH1K9Q2",
    size: 4 * TiB,
    type: "HDD",
    rotationrate: 5900,
    pool: null,
    temp: 33,
  },
];

const leaf = (d: (typeof disks)[number], extra: Record<string, unknown> = {}) => ({
  type: "DISK",
  disk: d.name,
  device: `${d.name}1`,
  guid: `guid-${d.serial}`,
  status: "ONLINE",
  children: [],
  stats: {
    read_errors: 0,
    write_errors: 0,
    checksum_errors: 0,
    self_healed: 0,
    size: d.size,
    allocated: d.size * 0.6,
    fragmentation: 4,
    ops: [0, 1200, 340],
    bytes: [0, 3.2 * TiB, 1.1 * TiB],
  },
  ...extra,
});

const pools = [
  {
    id: 1,
    name: "tank",
    status: "ONLINE",
    healthy: true,
    size: 32 * TiB,
    allocated: 19.4 * TiB,
    free: 12.6 * TiB,
    fragmentation: "4",
    scan: { function: "SCRUB", state: "FINISHED", percentage: 100, errors: 0, end_time: daysAgo(6) },
    topology: {
      data: [
        {
          type: "RAIDZ2",
          status: "ONLINE",
          guid: "vdev-tank",
          children: disks
            .slice(0, 4)
            .map((d) => leaf(d, d.name === "sdc" ? { stats: { ...leaf(d).stats, checksum_errors: 3 } } : {})),
        },
      ],
      cache: [],
      log: [],
      spare: [],
    },
  },
  {
    id: 2,
    name: "fast",
    status: "ONLINE",
    healthy: true,
    size: 1 * TiB,
    allocated: 0.42 * TiB,
    free: 0.58 * TiB,
    fragmentation: "11",
    scan: { function: "SCRUB", state: "FINISHED", percentage: 100, errors: 0, end_time: daysAgo(20) },
    topology: {
      data: [{ type: "MIRROR", status: "ONLINE", guid: "vdev-fast", children: disks.slice(4, 6).map((d) => leaf(d)) }],
      cache: [],
      log: [],
      spare: [],
    },
  },
];

const prop = (parsed: unknown, value?: string) => ({
  parsed,
  value: value ?? String(parsed),
  rawvalue: String(parsed),
});
const dataset = (name: string, used: number, avail: number, extra: Record<string, unknown> = {}) => ({
  id: name,
  name,
  pool: name.split("/")[0],
  type: "FILESYSTEM",
  encrypted: false,
  mountpoint: `/mnt/${name}`,
  used: prop(used),
  available: prop(avail),
  referenced: prop(used),
  quota: prop(0),
  compressratio: prop(1.12, "1.12x"),
  encryption: prop("off"),
  ...extra,
});
const datasets = [
  dataset("tank", 19.4 * TiB, 12.6 * TiB),
  dataset("tank/media", 14.1 * TiB, 12.6 * TiB),
  dataset("tank/family", 2.2 * TiB, 12.6 * TiB),
  dataset("tank/backups", 3.1 * TiB, 12.6 * TiB),
  dataset("tank/ix-apps", 40 * GiB, 12.6 * TiB),
  dataset("tank/private", 120 * GiB, 12.6 * TiB, {
    encrypted: true,
    locked: true,
    key_format: prop("PASSPHRASE"),
    keyformat: prop("PASSPHRASE"),
  }),
  dataset("fast", 0.42 * TiB, 0.58 * TiB),
  dataset("fast/apps", 0.4 * TiB, 0.58 * TiB),
];

const snapshots = [
  ...[1, 2, 3, 7, 14].map((d) => ({
    name: `tank/family@auto-${new Date(now - d * 86_400_000).toISOString().slice(0, 10)}_02-00`,
    dataset: "tank/family",
    snapshot_name: `auto-${new Date(now - d * 86_400_000).toISOString().slice(0, 10)}_02-00`,
    properties: { used: prop(1.2 * GiB), referenced: prop(2.2 * TiB), creation: prop(daysAgo(d)) },
    holds: {},
  })),
  {
    name: "tank/media@before-reorganise",
    dataset: "tank/media",
    snapshot_name: "before-reorganise",
    properties: { used: prop(5 * GiB), referenced: prop(14.1 * TiB), creation: prop(daysAgo(30)) },
    holds: { keep: true },
  },
];

const users = [
  {
    id: 1,
    uid: 0,
    username: "root",
    full_name: "root",
    email: null,
    shell: "/usr/bin/zsh",
    home: "/root",
    locked: true,
    builtin: true,
    smb: false,
    sudo_commands: [],
    groups: [1],
    local: true,
  },
  {
    id: 10,
    uid: 3000,
    username: "truenas_admin",
    full_name: "Administrator",
    email: "admin@example.test",
    shell: "/usr/bin/zsh",
    home: "/home/truenas_admin",
    locked: false,
    builtin: false,
    smb: true,
    sudo_commands: ["ALL"],
    groups: [10, 21],
    local: true,
  },
  {
    id: 11,
    uid: 3001,
    username: "anna",
    full_name: "Anna Example",
    email: null,
    shell: "/usr/sbin/nologin",
    home: "/var/empty",
    locked: false,
    builtin: false,
    smb: true,
    sudo_commands: [],
    groups: [21],
    local: true,
  },
  {
    id: 12,
    uid: 3002,
    username: "ben",
    full_name: "Ben Example",
    email: null,
    shell: "/usr/sbin/nologin",
    home: "/var/empty",
    locked: false,
    builtin: false,
    smb: true,
    sudo_commands: [],
    groups: [21, 22],
    local: true,
  },
];
const groups = [
  { id: 1, gid: 0, group: "root", builtin: true, smb: false, users: [1], local: true },
  { id: 10, gid: 3000, group: "truenas_admin", builtin: false, smb: true, users: [10], local: true },
  { id: 21, gid: 3001, group: "family", builtin: false, smb: true, users: [10, 11, 12], local: true },
  { id: 22, gid: 3002, group: "media", builtin: false, smb: true, users: [12], local: true },
];

const container = (id: string, service: string, image: string) => ({
  id,
  service_name: service,
  image,
  state: "running",
  port_config: [],
});
const apps = [
  {
    name: "plex",
    state: "RUNNING",
    upgrade_available: false,
    human_version: "1.41.4_2.1.0",
    version: "2.1.0",
    custom_app: false,
    portals: { "Web UI": "http://192.168.1.10:32400/web" },
    active_workloads: {
      containers: 1,
      used_ports: [{ container_port: 32400, protocol: "tcp", host_ports: [{ host_port: 32400, host_ip: "0.0.0.0" }] }],
      container_details: [
        container(
          "3f9a1c2b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a",
          "plex",
          "plexinc/pms-docker:1.41.4",
        ),
      ],
    },
    metadata: { icon: "", title: "Plex", train: "stable", app_version: "1.41.4", description: "Stream your media." },
  },
  {
    name: "nextcloud",
    state: "RUNNING",
    upgrade_available: true,
    human_version: "30.0.2_2.0.4",
    version: "2.0.4",
    custom_app: false,
    portals: { "Web UI": "http://192.168.1.10:30027" },
    active_workloads: {
      containers: 3,
      used_ports: [{ container_port: 80, protocol: "tcp", host_ports: [{ host_port: 30027, host_ip: "0.0.0.0" }] }],
      container_details: [
        container("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", "nextcloud", "nextcloud:30"),
        container("b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1", "postgres", "postgres:16"),
        container("c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2", "redis", "redis:7"),
      ],
    },
    metadata: {
      icon: "",
      title: "Nextcloud",
      train: "stable",
      app_version: "30.0.2",
      description: "Files, calendars and contacts under your own roof.",
    },
  },
  {
    name: "jellyfin",
    state: "STOPPED",
    upgrade_available: false,
    human_version: "10.10.3_1.2.1",
    version: "1.2.1",
    custom_app: false,
    portals: {},
    active_workloads: { containers: 0, used_ports: [], container_details: [] },
    metadata: {
      icon: "",
      title: "Jellyfin",
      train: "stable",
      app_version: "10.10.3",
      description: "The free software media system.",
    },
  },
  {
    name: "homepage",
    state: "RUNNING",
    upgrade_available: false,
    human_version: "custom",
    version: "1.0.0",
    custom_app: true,
    portals: {},
    active_workloads: {
      containers: 1,
      used_ports: [{ container_port: 3000, protocol: "tcp", host_ports: [{ host_port: 3000, host_ip: "0.0.0.0" }] }],
      container_details: [
        container(
          "d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3",
          "homepage",
          "ghcr.io/gethomepage/homepage:latest",
        ),
      ],
    },
    metadata: { title: "Custom App", train: "stable" },
  },
];

const catalog = [
  {
    name: "plex",
    title: "Plex",
    categories: ["media"],
    latest_version: "2.1.0",
    latest_human_version: "1.41.4_2.1.0",
    train: "stable",
    description: "Stream your media anywhere.",
    installed: true,
    home: "https://www.plex.tv",
    sources: ["https://github.com/plexinc/pms-docker"],
    screenshots: [],
    maintainers: [{ name: "truenas", url: "https://www.truenas.com/", email: "dev@ixsystems.com" }],
    last_update: "2026-08-30 10:00:00",
  },
  {
    name: "nextcloud",
    title: "Nextcloud",
    categories: ["productivity"],
    latest_version: "2.0.5",
    latest_human_version: "30.0.4_2.0.5",
    train: "stable",
    description: "Files, calendars and contacts.",
    installed: true,
    home: "https://nextcloud.com",
    sources: [],
    screenshots: [],
    maintainers: [],
    last_update: "2026-09-01 10:00:00",
  },
  {
    name: "jellyfin",
    title: "Jellyfin",
    categories: ["media"],
    latest_version: "1.2.1",
    latest_human_version: "10.10.3_1.2.1",
    train: "stable",
    description: "The free software media system.",
    installed: true,
    home: "https://jellyfin.org",
    sources: [],
    screenshots: [],
    maintainers: [],
    last_update: "2026-08-12 10:00:00",
  },
  {
    name: "immich",
    title: "Immich",
    categories: ["media", "productivity"],
    latest_version: "1.4.2",
    latest_human_version: "1.119.0_1.4.2",
    train: "stable",
    description: "Self-hosted photo and video backup.",
    installed: false,
    home: "https://immich.app",
    sources: [],
    screenshots: [],
    maintainers: [],
    last_update: "2026-09-05 10:00:00",
  },
  {
    name: "syncthing",
    title: "Syncthing",
    categories: ["productivity"],
    latest_version: "1.1.0",
    latest_human_version: "1.28.0_1.1.0",
    train: "stable",
    description: "Continuous file synchronisation.",
    installed: false,
    home: "https://syncthing.net",
    sources: [],
    screenshots: [],
    maintainers: [],
    last_update: "2026-08-20 10:00:00",
  },
  {
    name: "vaultwarden",
    title: "Vaultwarden",
    categories: ["security"],
    latest_version: "1.0.8",
    latest_human_version: "1.32.5_1.0.8",
    train: "community",
    description: "A Bitwarden-compatible password server.",
    installed: false,
    home: "https://github.com/dani-garcia/vaultwarden",
    sources: [],
    screenshots: [],
    maintainers: [],
    last_update: "2026-08-25 10:00:00",
  },
  {
    name: "pihole",
    title: "Pi-hole",
    categories: ["networking"],
    latest_version: "1.0.3",
    latest_human_version: "2024.07.0_1.0.3",
    train: "community",
    description: "Network-wide ad blocking.",
    installed: false,
    home: "https://pi-hole.net",
    sources: [],
    screenshots: [],
    maintainers: [],
    last_update: "2026-07-30 10:00:00",
  },
];

const questions = [
  {
    variable: "network",
    label: "Network",
    group: "Network",
    schema: {
      type: "dict",
      attrs: [
        { variable: "web_port", label: "Web port", schema: { type: "int", default: 30027, min: 1024, max: 65535 } },
        { variable: "host_network", label: "Use the host's network", schema: { type: "boolean", default: false } },
      ],
    },
  },
  {
    variable: "storage",
    label: "Storage",
    group: "Storage",
    schema: {
      type: "dict",
      attrs: [
        {
          variable: "data",
          label: "Where the files live",
          schema: {
            type: "dict",
            attrs: [
              {
                variable: "type",
                label: "Kind",
                schema: {
                  type: "string",
                  default: "ix_volume",
                  enum: [
                    { value: "ix_volume", description: "Let TrueNAS manage it" },
                    { value: "host_path", description: "A folder I choose" },
                  ],
                },
              },
              { variable: "host_path", label: "Folder", schema: { type: "string", default: "" } },
            ],
          },
        },
      ],
    },
  },
  { variable: "TZ", label: "Time zone", group: "General", schema: { type: "string", default: "Etc/UTC" } },
  { variable: "ix_context", schema: { type: "dict", hidden: true, attrs: [] } },
];

const services = [
  { id: 1, service: "cifs", state: "RUNNING", enable: true },
  { id: 2, service: "nfs", state: "RUNNING", enable: true },
  { id: 3, service: "ssh", state: "RUNNING", enable: true },
  { id: 4, service: "smartd", state: "RUNNING", enable: true },
  { id: 5, service: "ups", state: "STOPPED", enable: false },
];

const tree: Record<string, Array<{ name: string; type: "DIRECTORY" | "FILE"; size: number; mount?: boolean }>> = {
  "/mnt": [
    { name: "tank", type: "DIRECTORY", size: 0, mount: true },
    { name: "fast", type: "DIRECTORY", size: 0, mount: true },
  ],
  "/mnt/tank": [
    { name: "media", type: "DIRECTORY", size: 0, mount: true },
    { name: "family", type: "DIRECTORY", size: 0, mount: true },
    { name: "backups", type: "DIRECTORY", size: 0, mount: true },
    { name: "ix-apps", type: "DIRECTORY", size: 0, mount: true },
  ],
  "/mnt/tank/media": [
    { name: "Films", type: "DIRECTORY", size: 0 },
    { name: "Series", type: "DIRECTORY", size: 0 },
    { name: "Music", type: "DIRECTORY", size: 0 },
    { name: "library-index.json", type: "FILE", size: 4_812_330 },
  ],
  "/mnt/tank/media/Films": [
    { name: "Some Film (2019).mkv", type: "FILE", size: 4.1 * GiB },
    { name: "Another Film (2021).mkv", type: "FILE", size: 6.3 * GiB },
  ],
  "/mnt/tank/family": [
    { name: "Photos", type: "DIRECTORY", size: 0 },
    { name: "Documents", type: "DIRECTORY", size: 0 },
    { name: "holiday-2025.jpg", type: "FILE", size: 3_120_004 },
    { name: "insurance.pdf", type: "FILE", size: 812_004 },
  ],
  "/mnt/tank/backups": [
    { name: "laptop-anna", type: "DIRECTORY", size: 0 },
    { name: "phone-ben", type: "DIRECTORY", size: 0 },
  ],
  "/mnt/fast": [{ name: "apps", type: "DIRECTORY", size: 0, mount: true }],
};

/* ------------------------------------------------------------- answers */

type Params = unknown[];
const arg = <T>(p: Params, i: number): T => p[i] as T;
const filterBy = <T extends Record<string, unknown>>(rows: T[], filters: unknown): T[] => {
  if (!Array.isArray(filters)) return rows;
  return rows.filter((r) =>
    filters.every((f) => {
      if (!Array.isArray(f) || f.length < 3) return true;
      const [k, op, v] = f as [string, string, unknown];
      const actual = r[k];
      if (op === "=") return actual === v;
      if (op === "!=") return actual !== v;
      if (op === "^") return String(actual).startsWith(String(v));
      return true;
    }),
  );
};

let nextId = 5000;
const job = () => ++nextId;
const rows = (n: number, gen: (i: number) => number[]) => Array.from({ length: n }, (_, i) => gen(i));

const handlers: Record<string, (p: Params) => unknown> = {
  "auth.login_with_api_key": (p) => arg<string>(p, 0) === API_KEY,
  "auth.generate_token": () => "mock-shell-token",
  "core.subscribe": () => true,
  "core.get_methods": () => ({
    "pool.create": { job: true },
    "app.create": { job: true },
    "app.upgrade": { job: true },
    "app.update": { job: true },
    "app.delete": { job: true },
    "pool.scrub": { job: true },
  }),
  "core.get_jobs": (p) => {
    const id = Number(((arg<unknown[]>(p, 0) ?? [])[0] as unknown[])?.[2] ?? 0);
    return [
      {
        id,
        method: "mock",
        state: "SUCCESS",
        progress: { percent: 100, description: "Done" },
        error: null,
        result: null,
      },
    ];
  },
  "core.resize_shell": () => true,
  "system.info": () => ({
    version: "25.04.2",
    hostname: "demo-nas",
    uptime_seconds: 19 * 86_400 + 4_200,
    cores: 8,
    model: "Intel(R) Core(TM) i5-12400",
    physmem: 32 * GiB,
    loadavg: [0.42, 0.51, 0.47],
    system_product: "Demo",
  }),
  "system.product_type": () => "SCALE",
  "system.reboot": () => null,
  "system.shutdown": () => null,
  "pool.query": (p) => filterBy(pools, p[0]),
  "pool.create": () => job(),
  "pool.scrub": () => job(),
  "pool.export": () => job(),
  "pool.offline": () => true,
  "pool.replace": () => job(),
  "pool.dataset.query": (p) => filterBy(datasets, p[0]),
  "pool.dataset.create": (p) => ({
    ...dataset(String((arg<Record<string, unknown>>(p, 0) ?? {}).name ?? "tank/new"), 0, 12 * TiB),
  }),
  "pool.dataset.update": () => true,
  "pool.dataset.delete": () => true,
  "pool.snapshottask.query": () => [
    {
      id: 1,
      dataset: "tank/family",
      recursive: true,
      enabled: true,
      naming_schema: "auto-%Y-%m-%d_%H-%M",
      lifetime_value: 2,
      lifetime_unit: "WEEK",
      schedule: { minute: "0", hour: "2", dom: "*", month: "*", dow: "*" },
      allow_empty: true,
      state: { state: "FINISHED" },
    },
  ],
  "pool.snapshottask.create": () => ({ id: 2 }),
  "pool.snapshottask.update": () => ({ id: 1 }),
  "pool.snapshottask.delete": () => true,
  "pool.snapshottask.run": () => true,
  "zfs.snapshot.query": (p) => filterBy(snapshots, p[0]),
  "zfs.snapshot.create": (p) => ({
    name: `${(arg<Record<string, unknown>>(p, 0) ?? {}).dataset}@${(arg<Record<string, unknown>>(p, 0) ?? {}).name ?? "new"}`,
  }),
  "zfs.snapshot.delete": () => true,
  "zfs.snapshot.rollback": () => true,
  "zfs.snapshot.clone": () => true,
  "zfs.snapshot.hold": () => true,
  "zfs.snapshot.release": () => true,
  "replication.run_onetime": () => job(),
  "pool.scrub.query": () => [
    {
      id: 1,
      pool: 1,
      pool_name: "tank",
      threshold: 35,
      description: "Monthly scrub of tank",
      schedule: { minute: "0", hour: "3", dom: "1", month: "*", dow: "*" },
      enabled: true,
    },
  ],
  "pool.scrub.create": () => 2,
  "pool.scrub.delete": () => true,
  "smart.test.query": () => [
    {
      id: 1,
      disks: [],
      all_disks: true,
      type: "SHORT",
      desc: "Weekly short self-test",
      schedule: { hour: "2", dom: "*", month: "*", dow: "0" },
    },
  ],
  "smart.test.create": () => 2,
  "smart.test.delete": () => true,
  "cloudsync.providers": () => [
    { name: "B2", title: "Backblaze B2" },
    { name: "S3", title: "Amazon S3" },
  ],
  "cloudsync.credentials.query": () => [{ id: 1, name: "Backblaze", provider: { type: "B2" } }],
  "cloudsync.credentials.create": () => 2,
  "cloudsync.query": () => [
    {
      id: 1,
      description: "Family photos to Backblaze",
      path: "/mnt/tank/family",
      direction: "PUSH",
      transfer_mode: "COPY",
      credentials: { id: 1, name: "Backblaze", provider: { type: "B2" } },
      attributes: { bucket: "home-nas-backup", folder: "family" },
      schedule: { minute: "0", hour: "1", dom: "*", month: "*", dow: "*" },
      enabled: true,
      job: { state: "SUCCESS", time_finished: daysAgo(0.3) },
    },
  ],
  "cloudsync.create": () => 2,
  "cloudsync.delete": () => true,
  "cloudsync.sync": () => job(),
  "replication.query": () => [
    {
      id: 1,
      name: "Copy tank/family to fast/copies",
      direction: "PUSH",
      transport: "LOCAL",
      source_datasets: ["tank/family"],
      target_dataset: "fast/copies",
      recursive: true,
      auto: true,
      schedule: { minute: "0", hour: "4", dom: "*", month: "*", dow: "*" },
      enabled: true,
      state: { state: "FINISHED", datetime: daysAgo(0.5) },
    },
  ],
  "replication.create": () => 2,
  "replication.delete": () => true,
  "replication.run": () => job(),
  "ups.config": () => ({ mode: "MASTER", driver: "usbhid-ups$APC", port: "auto", monuser: "upsmon" }),
  "pool.dataset.lock": () => job(),
  "pool.dataset.unlock": () => job(),
  "pool.dataset.export_key": () => job(),
  "disk.query": (p) =>
    filterBy(
      disks.map((d) => ({
        ...d,
        identifier: `{serial}${d.serial}`,
        bus: d.type === "SSD" ? "NVME" : "SATA",
        subsystem: d.type === "SSD" ? "nvme" : "scsi",
        description: "",
        lunid: null,
        transfermode: "Auto",
        hddstandby: "ALWAYS ON",
        advpowermgmt: "DISABLED",
        togglesmart: true,
        imported_zpool: d.pool,
      })),
      p[0],
    ),
  "disk.details": () => ({
    used: disks
      .filter((d) => d.pool)
      .map((d) => ({
        ...d,
        imported_zpool: d.pool,
        exported_zpool: null,
        partitions: [{ name: `${d.name}1`, size: d.size - 2 * GiB, partition_type: "zfs" }],
        sectorsize: 4096,
        duplicate_serial: [],
      })),
    unused: disks
      .filter((d) => !d.pool)
      .map((d) => ({
        ...d,
        imported_zpool: null,
        exported_zpool: null,
        partitions: [],
        sectorsize: 4096,
        duplicate_serial: [],
      })),
  }),
  "disk.temperatures": () => Object.fromEntries(disks.map((d) => [d.name, d.temp])),
  "disk.retaste": () => true,
  "disk.wipe": () => job(),
  "disk.smart_attributes": (p) =>
    String(arg(p, 0)).startsWith("nvme")
      ? []
      : [
          { id: 5, name: "Reallocated_Sector_Ct", value: 100, worst: 100, thresh: 10, raw: { value: 0, string: "0" } },
          { id: 194, name: "Temperature_Celsius", value: 63, worst: 45, thresh: 0, raw: { value: 37, string: "37" } },
        ],
  "smart.test.results": () =>
    disks
      .filter((d) => d.pool)
      .map((d) => ({
        disk: d.name,
        name: d.name,
        tests: [
          {
            num: 1,
            type: "Short offline",
            status: "SUCCESS",
            status_verbose: "Completed without error",
            remaining: 0,
            lifetime: 4521,
            description: "Short offline",
          },
        ],
        current_test: null,
      })),
  "smart.test.manual_test": (p) =>
    (arg<Array<Record<string, unknown>>>(p, 0) ?? []).map((t) => ({
      disk: t.identifier,
      expected_result_time: { $date: now + 120_000 },
    })),
  "app.query": (p) => filterBy(apps, p[0]),
  "app.config": (p) => {
    const a = apps.find((x) => x.name === arg(p, 0));
    if (!a) throw new Error(`[ENOENT] App ${arg(p, 0)} not found`);
    if (a.custom_app)
      return { services: { homepage: { image: "ghcr.io/gethomepage/homepage:latest", ports: ["3000:3000"] } } };
    return {
      network: { web_port: 30027, host_network: false },
      storage: { data: { type: "ix_volume", host_path: "" } },
      TZ: "Europe/Vienna",
      nextcloud: { admin_user: "admin", admin_password: "correct-horse-battery-staple" },
      ix_context: { is_install: false },
    };
  },
  "app.available": (p) => filterBy(catalog, p[0]),
  "app.categories": () => ["media", "productivity", "security", "networking"],
  "app.create": () => job(),
  "app.update": () => job(),
  "app.upgrade": () => job(),
  "app.delete": () => job(),
  "app.start": () => null,
  "app.stop": () => null,
  "app.redeploy": () => job(),
  "catalog.get_app_details": (p) => {
    const row = catalog.find((c) => c.name === arg(p, 0)) ?? catalog[0];
    return { ...row, versions: { [row.latest_version]: { schema: { questions } } } };
  },
  "alert.list": () => [
    {
      uuid: "a1",
      level: "WARNING",
      formatted: "Pool tank: device sdc has 3 checksum errors.",
      dismissed: false,
      datetime: daysAgo(0.2),
      klass: "ZpoolCapacity",
    },
    {
      uuid: "a2",
      level: "INFO",
      formatted: "Scrub of pool tank finished with no errors.",
      dismissed: false,
      datetime: daysAgo(6),
      klass: "ScrubFinished",
    },
  ],
  "alert.dismiss": () => true,
  "service.query": () => services,
  "service.start": () => true,
  "service.stop": () => true,
  "service.restart": () => true,
  "service.update": () => true,
  "sharing.smb.query": (p) =>
    filterBy(
      [
        {
          id: 1,
          name: "Family",
          path: "/mnt/tank/family",
          enabled: true,
          comment: "Photos and documents",
          purpose: "DEFAULT_SHARE",
          ro: false,
        },
        {
          id: 2,
          name: "Media",
          path: "/mnt/tank/media",
          enabled: true,
          comment: "",
          purpose: "DEFAULT_SHARE",
          ro: true,
        },
      ],
      p[0],
    ),
  "sharing.smb.create": () => ({ id: 3 }),
  "sharing.smb.update": () => ({ id: 1 }),
  "sharing.smb.delete": () => true,
  "sharing.nfs.query": () => [
    {
      id: 1,
      path: "/mnt/tank/backups",
      enabled: true,
      comment: "Backups from the Linux boxes",
      networks: ["192.168.1.0/24"],
      hosts: [],
    },
  ],
  "sharing.nfs.create": () => ({ id: 2 }),
  "sharing.nfs.delete": () => true,
  "user.query": (p) => filterBy(users, p[0]),
  "user.create": (p) => ({
    id: 13,
    ...(arg<Record<string, unknown>>(p, 0) ?? {}),
    password: "x",
    unixhash: "x",
    smbhash: "x",
  }),
  "user.update": (p) => ({ id: arg(p, 0), unixhash: "x" }),
  "user.delete": () => true,
  "user.shell_choices": () => ({ "/usr/sbin/nologin": "nologin", "/usr/bin/bash": "bash", "/usr/bin/zsh": "zsh" }),
  "group.query": (p) => filterBy(groups, p[0]),
  "group.create": () => 23,
  "group.update": (p) => arg(p, 0),
  "group.delete": () => true,
  "filesystem.listdir": (p) => {
    const path = String(arg(p, 0)).replace(/\/+$/, "") || "/mnt";
    const list = tree[path];
    if (!list) throw new Error(`[ENOENT] Directory ${path} does not exist`);
    return list.map((e) => ({
      name: e.name,
      path: `${path}/${e.name}`,
      realpath: `${path}/${e.name}`,
      type: e.type,
      size: e.size,
      mode: e.type === "DIRECTORY" ? 16877 : 33188,
      uid: 3001,
      gid: 3001,
      is_mountpoint: !!e.mount,
      is_ctldir: false,
      mtime: (now - 3_600_000 * (e.name.length % 40)) / 1000,
    }));
  },
  "filesystem.statfs": (p) => {
    const path = String(arg(p, 0));
    if (path === "/mnt") throw new Error("[EINVAL] Not a filesystem");
    const ds = datasets.find((d) => path === d.mountpoint || path.startsWith(`${d.mountpoint}/`));
    const total = ds ? Number(ds.used.parsed) + Number(ds.available.parsed) : 0;
    return {
      source: ds?.name ?? "tank",
      total_bytes: total,
      used_bytes: ds ? Number(ds.used.parsed) : 0,
      avail_bytes: ds ? Number(ds.available.parsed) : 0,
    };
  },
  "filesystem.stat": (p) => ({ realpath: arg(p, 0), type: "DIRECTORY", size: 0, mode: 16877, uid: 3001, gid: 3001 }),
  "filesystem.getacl": (p) => ({
    path: arg(p, 0),
    uid: 3001,
    gid: 3001,
    acltype: "POSIX1E",
    trivial: false,
    acl: [
      { tag: "USER_OBJ", id: -1, perms: { READ: true, WRITE: true, EXECUTE: true }, default: false },
      { tag: "GROUP", id: 3001, perms: { READ: true, WRITE: true, EXECUTE: true }, default: false },
      { tag: "OTHER", id: -1, perms: { READ: false, WRITE: false, EXECUTE: false }, default: false },
    ],
  }),
  "filesystem.setacl": () => job(),
  "filesystem.setperm": () => job(),
  "filesystem.chown": () => job(),
  "filesystem.mkdir": (p) => ({ path: arg(p, 0) }),
  "interface.query": () => [
    {
      id: "eno1",
      name: "eno1",
      type: "PHYSICAL",
      description: "Motherboard",
      ipv4_dhcp: false,
      ipv6_auto: false,
      mtu: 1500,
      aliases: [{ type: "INET", address: "192.168.1.10", netmask: 24 }],
      state: { link_state: "LINK_STATE_UP", active_media_subtype: "1000baseT", link_address: "b4:2e:99:aa:bb:cc" },
    },
  ],
  "interface.has_pending_changes": () => false,
  "interface.update": () => true,
  "interface.commit": () => true,
  "interface.checkin": () => true,
  "interface.rollback": () => true,
  "network.configuration.config": () => ({
    hostname: "demo-nas",
    domain: "home.arpa",
    ipv4gateway: "192.168.1.1",
    ipv6gateway: "",
    nameserver1: "192.168.1.1",
    nameserver2: "1.1.1.1",
    nameserver3: "",
  }),
  "network.configuration.update": () => true,
  "mail.config": () => ({
    fromemail: "nas@example.test",
    fromname: "demo-nas",
    outgoingserver: "smtp.example.test",
    port: 587,
    security: "TLS",
    smtp: true,
    user: "nas@example.test",
    pass: "secret",
    oauth: {},
  }),
  "mail.update": () => true,
  "mail.send": () => true,
  "update.get_trains": () => ({
    trains: {
      "TrueNAS-SCALE-Fangtooth": { description: "25.04 stable" },
      "TrueNAS-SCALE-Goldeye": { description: "25.10 stable" },
    },
    current: "TrueNAS-SCALE-Fangtooth",
    selected: "TrueNAS-SCALE-Fangtooth",
  }),
  "update.check_available": () => ({
    status: "AVAILABLE",
    version: "25.04.3",
    changelog: "Bug fixes.",
    release_notes_url: "https://www.truenas.com/docs/scale/25.04/gettingstarted/scalereleasenotes/",
  }),
  "update.set_train": () => true,
  "update.download": () => job(),
  "update.update": () => job(),
  "system.license_update": () => true,
  "boot.environment.query": () => [
    { id: "25.04.2", active: true, created: daysAgo(40) },
    { id: "25.04.1", active: false, created: daysAgo(120) },
  ],
  "reporting.netdata_get_data": (p) => {
    const spec = (arg<Array<Record<string, unknown>>>(p, 0) ?? [])[0] ?? {};
    const n = 720;
    const start = Math.floor(now / 1000) - n * 120;
    const legend =
      spec.name === "interface"
        ? ["time", "received", "sent"]
        : spec.name === "memory"
          ? ["time", "available"]
          : ["time", "cpu"];
    const data = rows(n, (i) =>
      legend
        .slice(1)
        .map((_, k) =>
          spec.name === "memory"
            ? 14 * GiB + Math.sin(i / 40) * 2 * GiB
            : spec.name === "interface"
              ? 400_000 + Math.abs(Math.sin(i / 17 + k)) * 9_000_000
              : 8 + Math.abs(Math.sin(i / 23)) * 55,
        ),
    ).map((v, i) => [start + i * 120, ...v]);
    return [{ name: String(spec.name), legend, data, start, end: start + n * 120, aggregations: {} }];
  },
};

const fallback = (method: string): unknown => {
  console.log(`[mock] no answer for ${method}; sent an empty one`);
  if (method.endsWith(".query")) return [];
  return {};
};

/* ---------------------------------------------------------------- wire */

const wss = new WebSocketServer({ noServer: true });

function realtime(): unknown {
  const t = Date.now() / 1000;
  return {
    cpu: { cpu: { usage: 12 + Math.abs(Math.sin(t / 9)) * 30, temp: 47 } },
    memory: {
      physical_memory_total: 32 * GiB,
      physical_memory_available: 14 * GiB + Math.sin(t / 30) * GiB,
      arc_size: 11 * GiB,
    },
    interfaces: {
      eno1: {
        link_state: "LINK_STATE_UP",
        received_bytes_rate: 1_200_000 + Math.abs(Math.sin(t / 5)) * 40_000_000,
        sent_bytes_rate: 300_000 + Math.abs(Math.cos(t / 7)) * 9_000_000,
      },
    },
    disks: { read_bytes: 1e6, write_bytes: 4e5, read_ops: 40, write_ops: 12, busy: 8 },
    zfs: { arc_size: 11 * GiB },
  };
}

function api(ws: WebSocket): void {
  let authed = false;
  let subscribed: ReturnType<typeof setInterval> | null = null;
  ws.on("message", (raw) => {
    let msg: { id?: number; method?: string; params?: Params };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const { id, method = "", params = [] } = msg;
    const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    const fail = (message: string) =>
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message, data: { reason: message } } }));
    try {
      if (method === "auth.login_with_api_key") {
        authed = handlers[method](params) === true;
        return reply(authed);
      }
      if (!authed) return fail("Not authenticated");
      if (method === "core.subscribe" && params[0] === "reporting.realtime" && !subscribed) {
        subscribed = setInterval(() => {
          if (ws.readyState === ws.OPEN)
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "collection_update",
                params: { msg: "added", collection: "reporting.realtime", fields: realtime() },
              }),
            );
        }, 1000);
      }
      const h = handlers[method];
      reply(h ? h(params) : fallback(method));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });
  ws.on("close", () => {
    if (subscribed) clearInterval(subscribed);
  });
}

/** A pretend shell: a prompt, echo, and for the app console a stream of log lines. */
function shell(ws: WebSocket): void {
  let ready = false;
  let logs: ReturnType<typeof setInterval> | null = null;
  ws.on("message", (raw) => {
    const text = raw.toString();
    if (!ready) {
      ready = true;
      let command = "";
      try {
        command = String(JSON.parse(text)?.options?.command ?? "");
      } catch {
        /* a keystroke before the handshake; ignore */
      }
      ws.send(JSON.stringify({ msg: "connected", id: "mock-session" }));
      if (command.startsWith("docker logs")) {
        let n = 0;
        logs = setInterval(() => {
          if (ws.readyState !== ws.OPEN) return;
          n++;
          ws.send(
            `${new Date().toISOString()} [info] request handled in ${(Math.random() * 40 + 3).toFixed(1)}ms (mock log line ${n})\r\n`,
          );
        }, 700);
      } else if (command.startsWith("docker exec")) {
        ws.send("root@container:/# ");
      } else {
        ws.send("\r\nThis is the EzNAS mock. Nothing you type here runs anywhere.\r\ndemo-nas$ ");
      }
      return;
    }
    if (text.startsWith('{"resize"')) return;
    // Echo, with a new prompt on Enter.
    ws.send(text === "\r" ? "\r\ndemo-nas$ " : text);
  });
  ws.on("close", () => {
    if (logs) clearInterval(logs);
  });
}

export interface RunningMock {
  server: Server;
  port: number;
  /** What to give the console as the server address. */
  url: string;
  close(): Promise<void>;
}

/** Start answering on a port; 0 picks a free one. */
export function startMock(port: number): Promise<RunningMock> {
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`EzNAS mock TrueNAS. Point the console at ws://host:port with API key ${API_KEY}\n`);
  });
  http.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if ((req.url ?? "").startsWith("/websocket/shell")) shell(ws);
      else api(ws);
    });
  });
  return new Promise((resolve) => {
    http.listen(port, "127.0.0.1", () => {
      const actual = (http.address() as { port: number }).port;
      resolve({
        server: http,
        port: actual,
        url: `ws://127.0.0.1:${actual}/api/current`,
        close: () => new Promise((done) => http.close(() => done())),
      });
    });
  });
}

// Run directly: listen and say where.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.MOCK_PORT ?? 18443);
  void startMock(port).then((m) => console.log(`[mock] TrueNAS mock listening on ${m.url}  (API key: ${API_KEY})`));
}

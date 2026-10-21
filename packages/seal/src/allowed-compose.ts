// What the browser accepts as the core enclave. A quote that verifies but names anything else is refused.
//
// Compose hashes: sha256 of the CVM's app-compose.json (which embeds services/core/docker-compose.yml).
// EVERY core redeploy that changes services/core/docker-compose.yml (e.g. a new image digest) or the
// Phala app-compose settings changes this hash: add the new hash here IN THE SAME CHANGE, deploy, then
// drop the old one. Otherwise browsers refuse to seal. To read it from a running CVM:
//   curl -s https://<app-id>-8090.<gateway>/prpc/Info  ->  compose_hash (= sha256 of tcb_info.app_compose;
//   check that app_compose's docker_compose_file is byte-identical to services/core/docker-compose.yml).
export const ALLOWED_COMPOSE_HASHES: readonly string[] = [
  "67ed5271bc739541aa8e753bccd8cf477aea54de3d74c252f0aa7e0e499f43c2", // proviso-core@sha256:2675801a…0587, mainnet
];

// dstack OS measurements (firmware MRTD, kernel RTMR1, cmdline+initrd RTMR2). They change only when the
// CVM moves to another dstack OS image; read them from the same /prpc/Info (tcb_info.mrtd/rtmr1/rtmr2).
// RTMR0 is not pinned: it depends on the VM size (CPUs, memory).
export const ALLOWED_OS: readonly { image: string; mrtd: string; rtmr1: string; rtmr2: string }[] = [
  {
    image: "dstack-0.5.12",
    mrtd: "7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173",
    rtmr1: "4ae609807c765916a31d724786ed74bcb97e168a9d937b04936aeef2015c907eba5ac352c6bcd749c246fd62ffb659ec",
    rtmr2: "764489f277a8540189761e72b4238ba36d4d647e11bd958d8ab5522af2a4867b0ff63e06b0c4967f1857236244040a5d",
  },
];

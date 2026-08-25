// 배포 후 채운다. localhost 에서만 ?contract / ?rpc 오버라이드를 허용해 포크·테스트넷 리허설에 쓴다.
export const CONFIG = {
  chainId: 8453,
  chainName: "Base",
  rpc: "https://mainnet.base.org",
  contract: "0x0000000000000000000000000000000000000000", // ← 배포 후 교체
  explorer: "https://basescan.org",
  // 주소별 Merkle 증명: proofBase + lowercase(address) + ".json" → { "proof": ["0x..", ...] }
  // 경로는 mint.js 가 있는 app/ 을 기준으로 푼다 (문서 위치와 무관)
  // 파일이 없으면 알로우리스트 비대상.
  proofBase: "data/proof/",
};

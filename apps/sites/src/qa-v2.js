import { initialVault, VaultError } from './vault.js';

export const isQaId = id => typeof id==='string' && /^QA-[a-zA-Z0-9_-]{1,48}$/.test(id);

export function qaSeed(campaignId,worldlineId) {
  if (!isQaId(campaignId) || worldlineId!=='wl-qa') throw new VaultError('invalid_qa_scope','QA 需要 QA- 前缀和 wl-qa 世界线');
  const vault=initialVault();
  const snapshot=vault.campaigns.demo.lines['wl-main'];
  snapshot.manifest={...snapshot.manifest,id:campaignId,title:'Isolated Doupo QA',worldId:'doupo',worldlineId,consistencyRules:[]};
  snapshot.state={...snapshot.state,worldId:'doupo',worldlineId,revision:0,clock:{turn:null,date:null,period:null,elapsedMinutes:0,anchor:'QA-START'},rng:{algorithm:'mulberry32',seed:481,cursor:0}};
  snapshot.entities=[];
  snapshot.relations=[];
  snapshot.episodes=[];
  snapshot.working={memoryRevision:0,scene:'Synthetic QA',pendingEvents:[]};
  return {...vault,active:{campaignId,worldlineId},events:[],campaigns:{[campaignId]:{manifest:snapshot.manifest,lines:{[worldlineId]:snapshot}}}};
}

// Existing QA Vaults retain all data and receipts. Only this isolated namespace adopts Doupo rules.
export function useQaBusinessRules(doc,campaignId) {
  const campaign=doc.campaigns[campaignId];
  const line=campaign?.lines['wl-qa'];
  if (!line || line.state.worldId==='doupo') return;
  campaign.manifest.worldId='doupo';
  line.manifest.worldId='doupo';
  line.state.worldId='doupo';
}

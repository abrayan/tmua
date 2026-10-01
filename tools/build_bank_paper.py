#!/usr/bin/env python3
"""Compile reviewed official question matches into one portable practice HTML."""
import argparse,copy,json,tempfile
from pathlib import Path
from build_paper import build, is_reviewed_fallback, is_private_original, private_marked

def assemble(plan,bank, *, allow_private=False):
    if (private_marked(plan) or private_marked(bank)) and not allow_private:
        raise ValueError('Private purchased content requires the audited private-pair compiler')
    if allow_private and plan.get('metadata', {}).get('visibility') != 'private':
        raise ValueError('Private plans require explicit visibility')
    if bank.get('version')!=1 or not isinstance(bank.get('questions'),dict):
        raise ValueError('Question bank must contain version 1 and questions keyed by source ID')
    questions=bank['questions']; groups=[]
    requires_three=plan['metadata'].get('requiresThreeFollowups',False)
    if not isinstance(requires_three,bool):
        raise ValueError('requiresThreeFollowups must be a boolean')
    reserved_candidates=set()
    original_ids={g['originalId'] for g in plan['groups']}
    for item in plan['groups']:
        candidates=item['candidates']
        if not isinstance(candidates,list) or any(not isinstance(qid,str) for qid in candidates):
            raise ValueError(f"{item['id']}: candidates must be a list of source IDs")
        if len(candidates)>3 or len(candidates)!=len(set(candidates)):raise ValueError(f"{item['id']}: choose at most three distinct reviewed matches")
        if requires_three and len(candidates)!=3:
            raise ValueError(f"{item['id']}: requiresThreeFollowups needs exactly three distinct reviewed matches")
        reused=set(candidates)&reserved_candidates
        if requires_three and reused:
            raise ValueError(f"{item['id']}: follow-up source IDs must be unique across this paper: {', '.join(sorted(reused))}")
        reserved_candidates.update(candidates)
        ids=[item['originalId'],*candidates]
        for qid in ids:
            if qid not in questions or questions[qid].get('sourceId')!=qid:raise ValueError(f'Question missing from bank: {qid}')
            if questions[qid].get('provider')!='official-tmua' and not (qid in candidates and is_reviewed_fallback(questions[qid])) and not (allow_private and qid == item['originalId'] and is_private_original(questions[qid], plan['metadata'])):
                raise ValueError(f'{qid}: this plan requires an official TMUA source or a reviewed TMUA.co.uk follow-up')
        if set(candidates)&original_ids:raise ValueError('Do not reveal a question from this assessment as follow-up practice')
        group={'id':item['id'],'original':copy.deepcopy(questions[ids[0]]),'similar':[copy.deepcopy(questions[x]) for x in candidates]}
        if 'legacyCandidates' in item:
            old=item['legacyCandidates']
            if not isinstance(old,list) or len(old)>3 or any(not isinstance(qid,str) for qid in old) or len(set(old))!=len(old):
                raise ValueError(f"{item['id']}: legacyCandidates must contain zero to three distinct source IDs")
            if set(old)&original_ids:
                raise ValueError('Do not reveal a question from this assessment as legacy follow-up practice')
            for qid in old:
                if qid not in questions or questions[qid].get('sourceId')!=qid or questions[qid].get('provider')!='official-tmua':
                    raise ValueError(f'{qid}: missing official legacy exercise')
            group['legacySimilar']=[copy.deepcopy(questions[qid]) for qid in old]
        groups.append(group)
    return {'metadata':plan['metadata'],'questions':groups}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('plan',type=Path);p.add_argument('output',type=Path);p.add_argument('--bank',type=Path,default=Path(__file__).resolve().parent.parent/'content/official-question-bank.json');args=p.parse_args()
    data=assemble(json.loads(args.plan.read_text()),json.loads(args.bank.read_text()))
    with tempfile.TemporaryDirectory() as folder:
        source=Path(folder)/'paper.json';source.write_text(json.dumps(data,ensure_ascii=False));build(source,args.output)
if __name__=='__main__':main()

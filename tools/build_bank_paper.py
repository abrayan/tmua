#!/usr/bin/env python3
"""Compile reviewed official question matches into one portable practice HTML."""
import argparse,copy,json,tempfile
from pathlib import Path
from build_paper import build

def assemble(plan,bank):
    if bank.get('version')!=1 or not isinstance(bank.get('questions'),dict):
        raise ValueError('Question bank must contain version 1 and questions keyed by source ID')
    questions=bank['questions']; groups=[]
    original_ids={g['originalId'] for g in plan['groups']}
    for item in plan['groups']:
        candidates=item['candidates']
        if len(candidates)>3 or len(candidates)!=len(set(candidates)):raise ValueError(f"{item['id']}: choose at most three distinct reviewed matches")
        ids=[item['originalId'],*candidates]
        for qid in ids:
            if qid not in questions or questions[qid].get('sourceId')!=qid:raise ValueError(f'Question missing from bank: {qid}')
            if questions[qid].get('provider')!='official-tmua':raise ValueError(f'{qid}: this plan requires an official TMUA source')
        if set(candidates)&original_ids:raise ValueError('Do not reveal a question from this assessment as follow-up practice')
        groups.append({'id':item['id'],'original':copy.deepcopy(questions[ids[0]]),'similar':[copy.deepcopy(questions[x]) for x in candidates]})
    return {'metadata':plan['metadata'],'questions':groups}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('plan',type=Path);p.add_argument('output',type=Path);p.add_argument('--bank',type=Path,default=Path(__file__).resolve().parent.parent/'content/official-question-bank.json');args=p.parse_args()
    data=assemble(json.loads(args.plan.read_text()),json.loads(args.bank.read_text()))
    with tempfile.TemporaryDirectory() as folder:
        source=Path(folder)/'paper.json';source.write_text(json.dumps(data,ensure_ascii=False));build(source,args.output)
if __name__=='__main__':main()

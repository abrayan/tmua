"""Approval must precede private presentation normalization; reviewed inputs stay intact.

Uses synthetic public-question fixtures. Real omission-proof validation has its
own audit-gate regressions; these tests cover the compiler/rendering boundary.
"""
import copy, hashlib, json, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import build_private_pair as compiler
from build_bank_paper import assemble
from test_private_compiler import fixture


def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def prepare(root):
    data = fixture()
    original = data['questions'][0]['original']
    follow = data['questions'][0]['similar'][0]
    original['hints'][0]['recall'] = []
    follow['hints'][0]['recall'] = []
    second = copy.deepcopy(original)
    second.update(sourceId='TYLER-EXAM-A-P2-Q01', sourceUrl='https://jzmaths.com/simulator/tyler_exam_a_p2')
    (root/'bank.json').write_text(json.dumps({'version':1,'questions':{q['sourceId']:q for q in [original,second,follow]}}))
    for n,q in [(1,original),(2,second)]:
        plan={'metadata':{**data['metadata'],'id':f'tyler-exam-a-p{n}','paper':n},'groups':[{'id':'q1','originalId':q['sourceId'],'candidates':[follow['sourceId']]}]}
        (root/f'p{n}.json').write_text(json.dumps(plan))
    (root/'config.json').write_text(json.dumps({'plans':['p1.json','p2.json'],'bank':'bank.json'}))
    inputs={str(p):digest(p) for p in root.glob('*.json')}
    audit={'pairId':'tyler-exam-a','editionId':'synthetic-reviewed','inputs':inputs,'mappings':[{'versionId':'synthetic-reviewed','paper':{'id':f'tyler-exam-a-p{n}'}} for n in [1,2]]}
    return inputs,audit


class PrivateRecallOmissionTests(unittest.TestCase):
    def test_failed_review_stops_before_normalization_or_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);inputs,_=prepare(root)
            result=SimpleNamespace(returncode=1,stderr='Unreviewed recall omission',stdout='')
            with patch.object(compiler.subprocess,'run',return_value=result), patch.object(compiler,'assemble') as assembly, patch.object(compiler,'build') as rendering:
                with self.assertRaisesRegex(ValueError,'Unreviewed recall omission'):
                    compiler.build_private_pair(root/'config.json',root/'out')
                assembly.assert_not_called();rendering.assert_not_called()
            self.assertFalse((root/'out').exists())
            self.assertTrue(all(digest(p)==h for p,h in inputs.items()))

    def test_approved_omission_changes_only_transient_presentation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);inputs,audit=prepare(root);captured=[]
            def approval(*args,**kwargs):
                bank=json.loads((root/'bank.json').read_text())
                self.assertEqual(bank['questions']['TYLER-EXAM-A-P1-Q01']['hints'][0]['recall'],[])
                return SimpleNamespace(returncode=0,stderr='',stdout=json.dumps(audit))
            def capture(plan,bank,**kwargs):
                captured.append((bank,copy.deepcopy(bank)))
                return assemble(plan,bank,**kwargs)
            with patch.object(compiler.subprocess,'run',side_effect=approval),patch.object(compiler,'assemble',side_effect=capture):
                manifest=compiler.build_private_pair(root/'config.json',root/'out')
            self.assertEqual(len(manifest['papers']),2)
            self.assertTrue(all(digest(p)==h for p,h in inputs.items()))
            for actual,before in captured:self.assertEqual(actual,before,'The shared reviewed bank must not be mutated')
            for row in manifest['papers']:
                self.assertEqual(row['presentationNormalizations']['reviewedEmptyRecallKeysOmitted'],[{'sourceId':f"TYLER-EXAM-A-P{row['paper_number']}-Q01",'hintNumber':1},{'sourceId':'2021-P1-Q01','hintNumber':1}])
                text=(root/'out'/row['object_path']).read_text();marker='<script id="tmua-paper-data" type="application/json">'
                rendered=json.loads(text.split(marker,1)[1].split('</script>',1)[0]);group=rendered['questions'][0]
                for q in [group['original'],*group['similar']]:
                    self.assertNotIn('recall',q['hints'][0]);before=captured[0][1]['questions'][q['sourceId']]
                    self.assertEqual(q['hints'][0]['body'],before['hints'][0]['body'])
                    for i,hint in enumerate(q['hints'][1:],start=1):
                        if before['hints'][i].get('recall'):
                            self.assertEqual([{k:r[k] for k in ['lessonId','reminder']} for r in hint['recall']],before['hints'][i]['recall'])
                self.assertEqual(digest(root/'out'/row['object_path']),row['sha256'])


if __name__=='__main__':unittest.main()

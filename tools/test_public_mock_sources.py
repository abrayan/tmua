"""Public Mock identity never admits purchased Exam Sets or mock follow-ups."""
import copy
import json
from pathlib import Path
import unittest

from build_paper import validate
from build_bank_paper import assemble
from public_mock_sources import is_public_mock_metadata, is_public_mock_original, public_mock_url

ROOT = Path(__file__).resolve().parents[1]


def fixture(letter='A', paper=1):
    base = json.loads((ROOT/'content/official-question-bank.json').read_text())['questions']['2020-P1-Q01']
    metadata = {'format':'tmua-paper-v1','id':f'jz-mock-{letter.lower()}-p{paper}','pairId':f'jz-{letter.lower()}',
                'paper':paper,'title':f'JZ Mock {letter} · Paper {paper}','version':1,'questionCount':20,
                'provider':'jzmaths-mock','visibility':'public','source':f'JZ Maths · Mock {letter}',
                'sourceUrl':public_mock_url(letter,paper),'description':'Synthetic compiler test fixture.',
                'practicePolicy':'after-miss-up-to-3'}
    questions = {}
    groups = []
    for n in range(1,21):
        sid=f'JZ-MOCK-{letter}-P{paper}-Q{n:02d}'
        q=copy.deepcopy(base);q.update(sourceId=sid,provider='jzmaths-mock',source=f'JZ Maths · Mock {letter} · Q{n}',sourceUrl=metadata['sourceUrl'])
        questions[sid]=q;groups.append({'id':f'q{n}','originalId':sid,'candidates':[]})
    return {'metadata':metadata,'groups':groups},{'version':1,'questions':questions}


class PublicMockIdentityTests(unittest.TestCase):
    def test_all_five_public_pairs_assemble_and_validate_with_attribution(self):
        for letter in 'ABCDE':
            for paper in (1,2):
                with self.subTest(letter=letter,paper=paper):
                    plan,bank=fixture(letter,paper);data=assemble(plan,bank);validate(data, ROOT/'content/studied-lessons.json', ROOT/'assets/studied-concepts.json')
                    self.assertEqual(data['metadata']['provider'],'jzmaths-mock')
                    self.assertEqual(data['questions'][-1]['original']['sourceId'],f'JZ-MOCK-{letter}-P{paper}-Q20')
                    self.assertEqual(data['questions'][0]['original']['sourceUrl'],public_mock_url(letter,paper))

    def test_metadata_cannot_change_identity_or_private_source(self):
        mutations={'id':['jz-exam-a-p1','jz-mock-f-p1','jz-mock-a-p2'], 'pairId':['jz-exam-a','jz-b'],
                   'provider':['official-tmua','jzmaths-exam','jzmaths-tyler'], 'visibility':['private',None],
                   'paper':[2,True], 'questionCount':[1,19,21], 'practicePolicy':[None], 'source':['TMUA official','JZ Maths Mock B',''],
                   'sourceUrl':['https://jzmaths.com/simulator/jz_exam_a_p1','https://jzmaths.com/papers/jz_mocks/jz_mock_b_p1_question.pdf','https://jzmaths.com/papers/jz_mocks/jz_mock_a_p2_question.pdf','http://jzmaths.com/papers/jz_mocks/jz_mock_a_p1_question.pdf','https://u:p@jzmaths.com/papers/jz_mocks/jz_mock_a_p1_question.pdf','https://jzmaths.com/papers/jz_mocks/jz_mock_a_p1_question.pdf?paid=true','https://jzmaths.com/papers/jz_mocks/jz_mock_a_p1_question.pdf#page=2','https://jzmaths.com:443/papers/jz_mocks/jz_mock_a_p1_question.pdf']}
        for field,values in mutations.items():
            for value in values:
                with self.subTest(field=field,value=value):
                    plan,bank=fixture();plan['metadata'][field]=value
                    self.assertFalse(is_public_mock_metadata(plan['metadata']))
                    with self.assertRaises(ValueError):assemble(plan,bank)

    def test_original_provider_source_and_question_identity_must_match(self):
        for field,value in [('provider','official-tmua'),('provider','jzmaths-exam'),('sourceId','JZ-EXAM-A-P1-Q01'),('sourceId','JZ-MOCK-F-P1-Q01'),('sourceId','JZ-MOCK-A-P2-Q01'),('sourceId','JZ-MOCK-A-P1-Q00'),('sourceId','JZ-MOCK-A-P1-Q21'),('source','Official TMUA'),('sourceUrl','https://jzmaths.com/simulator/jz_exam_a_p1'),('visibility','private')]:
            with self.subTest(field=field,value=value):
                plan,bank=fixture();data=assemble(plan,bank);q=data['questions'][0]['original'];q[field]=value
                self.assertFalse(is_public_mock_original(q,data['metadata']))
                with self.assertRaises(ValueError):validate(data)

    def test_mock_cannot_be_smuggled_as_followup_or_official_original(self):
        plan,bank=fixture();data=assemble(plan,bank)
        data['questions'][0]['similar']=[copy.deepcopy(data['questions'][1]['original'])]
        with self.assertRaisesRegex(ValueError,'never follow-ups'):validate(data)
        plan['groups'][0]['candidates']=[plan['groups'][1]['originalId']]
        with self.assertRaisesRegex(ValueError,'never a follow-up'):assemble(plan,bank)
        plan['groups'][0]['candidates']=[];plan['metadata'].update(id='tmua-test-p1',provider='official-tmua')
        with self.assertRaises(ValueError):assemble(plan,bank)

    def test_full_original_order_required(self):
        for operation in ['reverse','missing','duplicate']:
            with self.subTest(operation=operation):
                plan,bank=fixture()
                if operation=='reverse':plan['groups'].reverse()
                elif operation=='missing':plan['groups'].pop()
                else:plan['groups'][-1]['originalId']=plan['groups'][0]['originalId']
                with self.assertRaisesRegex(ValueError,'Q01–Q20'):assemble(plan,bank)

    def test_official_followups_still_work_and_paid_content_stays_private(self):
        plan,bank=fixture();q=copy.deepcopy(next(iter(bank['questions'].values())));q.update(provider='official-tmua',sourceId='2020-P1-Q01',source='TMUA2020',sourceUrl='https://example.test/official.pdf');bank['questions'][q['sourceId']]=q;plan['groups'][0]['candidates']=[q['sourceId']]
        self.assertEqual(assemble(plan,bank)['questions'][0]['similar'][0]['provider'],'official-tmua')
        with self.assertRaises(ValueError):assemble(plan,bank,allow_private=True)
        bank['questions']['private']={'sourceId':'JZ-EXAM-A-P1-Q01','provider':'jzmaths-exam'}
        with self.assertRaisesRegex(ValueError,'Private purchased'):assemble(plan,bank)

if __name__=='__main__':unittest.main()

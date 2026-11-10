"""验证真实分词器的输入上限和长文覆盖，不加载大模型。"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parents[1] / 'harness'))
from knowledge_chunks import Section
from memory_embedding import BoundedEmbedding, bounded_chunks, MAX_TOKENS


class EmbeddingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        try:
            from tokenizers import Tokenizer, models, pre_tokenizers
            import memsearch.chunker
        except ImportError:
            self.skipTest('需要 memsearch 和 tokenizers 环境')
        tokenizer = Tokenizer(models.BPE(unk_token='[UNK]'))
        tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel()
        self.delegate_calls = []
        async def embed(texts):
            self.delegate_calls.append(texts)
            return [[1, 0] for _ in texts]
        self.wrapper = BoundedEmbedding(SimpleNamespace(_tokenizer=tokenizer, embed=embed, model_name='test'))

    async def test_long_blocks_and_single_lines_preserve_every_character_and_source_line(self):
        # 用字符计数做更严格的分段边界，含中文、代码、空行和超长单行。
        text = '```cpp\n' + 'value();\n' * 1000 + '\n中文😀' * 1000 + '长行' * 6000 + '\n```'
        sections = [Section(7, 7 + text.count('\n'), '规则', text)]
        chunks = list(bounded_chunks(sections, source='guide.md', title='手册', token_count=len))
        bodies = [c.content.split('\n', 2)[2] for c in chunks]
        self.assertEqual(''.join(bodies), text)
        self.assertTrue(all(len(c.content) <= MAX_TOKENS for c in chunks))
        line = 7
        for index, (chunk, body) in enumerate(zip(chunks, bodies)):
            self.assertEqual(chunk.start_line, line)
            if index == len(chunks) - 1:
                self.assertEqual(chunk.end_line, sections[0].end_line)
            else:
                self.assertEqual(chunk.end_line, line + body.count('\n') - int(body.endswith('\n')))
            line += body.count('\n')
        self.assertEqual(line, 7 + text.count('\n'))

    async def test_overlong_queries_fail_before_delegate_and_batches_are_single(self):
        # 真实 tokenizer 可含不同词表；边界断言使用可控计数，不依赖模型缓存。
        self.wrapper.token_count = len
        with self.assertRaisesRegex(ValueError, '输入过长'):
            await self.wrapper.embed(['a' * (MAX_TOKENS + 1)])
        self.assertEqual(self.delegate_calls, [])
        await self.wrapper.embed(['short', 'another'])
        self.assertEqual(self.delegate_calls, [['short'], ['another']])

    async def test_cached_bge_tokenizer_bounds_long_multilingual_input_without_loss(self):
        from tokenizers import Tokenizer
        try:
            from huggingface_hub import hf_hub_download
            path = hf_hub_download('gpahal/bge-m3-onnx-int8', 'tokenizer.json', local_files_only=True)
        except Exception as error:
            self.skipTest(f'需要已缓存的 BGE 分词器: {type(error).__name__}')
        self.wrapper = BoundedEmbedding(SimpleNamespace(_tokenizer=Tokenizer.from_file(path)))
        text = ('中文规则 English identifier_123 😀\n' * 700) + '禁止遗漏文末例外。'
        parts = list(bounded_chunks([Section(1, len(text.splitlines()), '规则', text)],
                     source='manual.md', title='手册', token_count=self.wrapper.token_count))
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(self.wrapper.token_count(p.content) <= MAX_TOKENS for p in parts))
        self.assertEqual(''.join(p.content.split('\n', 2)[2] for p in parts), text)


if __name__ == '__main__': unittest.main()

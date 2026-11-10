"""限制本地模型的单次输入和计算资源，不截掉知识原文。"""
from contextlib import contextmanager
from memory_runtime import CURRENT

MAX_TOKENS = 1024
EMBEDDING_BATCH_SIZE = 1


@contextmanager
def onnx_options(provider):
    if provider != 'onnx':
        yield
        return
    import onnxruntime as ort
    original = ort.InferenceSession

    def create(path, sess_options=None, **kwargs):
        options = sess_options or ort.SessionOptions()
        # 默认内存池会保留长输入产生的峰值；本进程优先保护宿主资源。
        options.enable_cpu_mem_arena = False
        options.enable_mem_pattern = False
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        return original(path, sess_options=options, **kwargs)

    ort.InferenceSession = create
    try:
        yield
    finally:
        ort.InferenceSession = original


class BoundedEmbedding:
    def __init__(self, delegate):
        from tokenizers import Tokenizer
        self.delegate = delegate
        self.tokenizer = Tokenizer.from_str(delegate._tokenizer.to_str())
        self.tokenizer.no_padding()
        self.tokenizer.no_truncation()
        delegate._tokenizer.enable_truncation(max_length=MAX_TOKENS)

    def __getattr__(self, name):
        return getattr(self.delegate, name)

    @property
    def batch_size(self):
        return EMBEDDING_BATCH_SIZE

    def token_count(self, text):
        return len(self.tokenizer.encode(text).ids)

    async def embed(self, texts):
        largest = 0
        for text in texts:
            # 字符上限先挡住巨型查询，避免分词本身耗尽内存。
            if len(text) > 16_384:
                raise ValueError('检索输入过长，请缩短查询；知识文档需要分段索引')
            tokens = self.token_count(text)
            largest = max(largest, tokens)
            if tokens > MAX_TOKENS:
                raise ValueError('检索输入过长，请缩短查询；知识文档需要分段索引')
        request = CURRENT.get()
        if request:
            request.timings['embedding_max_tokens'] = max(request.timings.get('embedding_max_tokens', 0), largest)
            request.timings['embedding_batch_size'] = EMBEDDING_BATCH_SIZE
        result = []
        for text in texts:
            result.extend(await self.delegate.embed([text]))
        return result


def bounded_chunks(sections, *, source, title, token_count):
    """长代码块和单行也切分；每个片段保留原文行号，正文无遗漏。"""
    from memsearch.chunker import Chunk
    for section in sections:
        prefix = f'资料主题：{title[:256]}\n章节：{section.heading[:256]}\n'
        while token_count(prefix) > MAX_TOKENS // 4:
            prefix = prefix[:len(prefix) // 2]
        content = section.content
        cursor = 0
        line = section.start_line
        while cursor < len(content):
            # 限定分词窗口；超长文档不会一次变成巨型 token 数组。
            lo, hi = 0, min(4096, len(content) - cursor)
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if token_count(prefix + content[cursor:cursor + mid]) <= MAX_TOKENS:
                    lo = mid
                else:
                    hi = mid - 1
            if not lo:
                raise ValueError('索引片段无法满足模型输入上限')
            end = cursor + lo
            if end < len(content):
                newline = content.rfind('\n', cursor, end)
                if newline >= cursor:
                    end = newline + 1
            part = content[cursor:end]
            if token_count(prefix + part) > MAX_TOKENS:
                # 截到换行后，分词边界也可能变化；退回已验证的字符边界。
                end = cursor + lo
                part = content[cursor:end]
            yield Chunk(content=prefix + part, source=source, heading=section.heading or title,
                        heading_level=1, start_line=line,
                        end_line=(section.end_line if end == len(content) else
                                  line + part.count('\n') - int(part.endswith('\n'))))
            line += part.count('\n')
            cursor = end

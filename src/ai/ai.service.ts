import { Inject, Injectable, Query } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import type { Runnable } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';

@Injectable()
export class AiService {
    private readonly chain: Runnable;

    constructor(
        @Inject('CHAT_MODEL') model: ChatOpenAI,
    ) {
        const prompt = PromptTemplate.fromTemplate(
            '请回答以下问题：\n\n{query}',
        );
        this.chain = prompt.pipe(model).pipe(new StringOutputParser());
    }

    async runChain(query: string): Promise<string> {
        return this.chain.invoke({ query });
    }

    async *streamChain(query: string): AsyncGenerator<string> {
        const stream = await this.chain.stream({ query });
        for await (const chunk of stream) {
            yield chunk;
        }
    }
}
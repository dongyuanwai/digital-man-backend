import { Inject, Injectable, Query } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import type { Runnable } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { tool } from '@langchain/core/tools';
import {
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
    AIMessageChunk
} from '@langchain/core/messages';


@Injectable()
export class AiService {
    private readonly chain: Runnable;
    private readonly modelWithTools: Runnable<BaseMessage[], AIMessage>;

    constructor(
        @Inject('CHAT_MODEL') model: ChatOpenAI,
        @Inject('SEND_MAIL_TOOL') private readonly sendMailTool: any,
        @Inject('WEB_SEARCH_TOOL') private readonly webSearchTool: any,
        @Inject('DB_USERS_CRUD_TOOL') private readonly dbUsersCrudTool: any,
    ) {
        const prompt = PromptTemplate.fromTemplate(
            '请回答以下问题：\n\n{query}',
        );
        this.chain = prompt.pipe(model).pipe(new StringOutputParser());

        this.modelWithTools = model.bindTools([
            this.sendMailTool,
            this.webSearchTool,
            this.dbUsersCrudTool,
        ]);
    }

    async runChain(query: string): Promise<string> {
        const messages: BaseMessage[] = [
            new SystemMessage(
                '你是一个智能助手，可以在需要时调用工具（如 query_user）来查询用户信息，再用结果回答用户的问题。',
            ),
            new HumanMessage(query),
        ];

        while (true) {
            const aiMessage = await this.modelWithTools.invoke(messages);
            messages.push(aiMessage);

            const toolCalls = aiMessage.tool_calls ?? [];

            // 没有要调用的工具，直接把回答返回给调用方
            if (!toolCalls.length) {
                return aiMessage.content as string;
            }

            // 依次执行本轮需要调用的所有工具
            for (const toolCall of toolCalls) {
                const toolCallId = toolCall.id || '';
                const toolName = toolCall.name;

                if (toolName === 'send_mail') {
                    const result = await this.sendMailTool.invoke(toolCall.args);
                    messages.push(
                        new ToolMessage({
                            tool_call_id: toolCallId,
                            name: toolName,
                            content: result,
                        }),
                    );
                } else if (toolName === 'db_users_crud') {
                    const result = await this.dbUsersCrudTool.invoke(toolCall.args);
                    messages.push(
                        new ToolMessage({
                            tool_call_id: toolCallId,
                            name: toolName,
                            content: result,
                        }),
                    );
                }
            }
        }
    }

    async *streamChain(query: string): AsyncGenerator<string> {
        const stream = await this.chain.stream({ query });
        for await (const chunk of stream) {
            yield chunk;
        }
    }
    async *runChainStream(query: string): AsyncIterable<string> {
        const messages: BaseMessage[] = [
            new SystemMessage(
                '你是一个智能助手，可以在需要时调用工具（如 query_user）来查询用户信息，再用结果回答用户的问题。',
            ),
            new HumanMessage(query),
        ];

        while (true) {
            // 一轮对话：先让模型思考并（可能）提出工具调用
            const stream = await this.modelWithTools.stream(messages);

            let fullAIMessage: AIMessageChunk | null = null;

            for await (const chunk of stream as AsyncIterable<AIMessageChunk>) {
                // 使用 concat 持续拼接，得到本轮完整的 AIMessageChunk
                fullAIMessage = fullAIMessage ? fullAIMessage.concat(chunk) : chunk;

                const hasToolCallChunk =
                    !!fullAIMessage.tool_call_chunks &&
                    fullAIMessage.tool_call_chunks.length > 0;

                // 只要当前轮次还没出现 tool 调用的 chunk，就可以把文本内容流式往外推
                if (!hasToolCallChunk && chunk.content) {
                    yield chunk.content as string
                }
            }

            if (!fullAIMessage) {
                return;
            }

            messages.push(fullAIMessage);

            const toolCalls = fullAIMessage.tool_calls ?? [];

            // 没有工具调用：说明这一轮就是最终回答，已经在上面的 for-await 中流完了，可以结束
            if (!toolCalls.length) {
                return;
            }

            // 有工具调用：本轮我们不再额外输出内容，而是执行工具，生成 ToolMessage，进入下一轮
            console.log("🚀 ~ AiService ~ runChainStream ~ toolCalls:", toolCalls)
            for (const toolCall of toolCalls) {
                const toolCallId = toolCall.id || '';
                const toolName = toolCall.name;
                console.log("🚀 ~ AiService ~ runChainStream ~ toolName:", toolName)

                if (toolName === 'send_mail') {
                    console.log("🚀 ~ AiService ~ runChainStream ~ result:", toolCall.args)
                    const result = await this.sendMailTool.invoke(toolCall.args);
                    messages.push(
                        new ToolMessage({
                            tool_call_id: toolCallId,
                            name: toolName,
                            content: result,
                        }),
                    );

                } else if (toolName === 'web_search') {
                    console.log("🚀 ~ AiService ~ runChainStream ~ web_search args:", toolCall.args)
                    const result = await this.webSearchTool.invoke(toolCall.args);
                    messages.push(
                        new ToolMessage({
                            tool_call_id: toolCallId,
                            name: toolName,
                            content: result,
                        }),
                    );
                } else if (toolName === 'db_users_crud') {
                    console.log("🚀 ~ AiService ~ runChainStream ~ db_users_crud args:", toolCall.args)
                    const result = await this.dbUsersCrudTool.invoke(toolCall.args);
                    messages.push(
                        new ToolMessage({
                            tool_call_id: toolCallId,
                            name: toolName,
                            content: result,
                        }),
                    );
                }
            }
        }
    }
}
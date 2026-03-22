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
        @Inject('TIME_NOW_TOOL') private readonly timeNowTool: any,
        @Inject('CRON_JOB_TOOL') private readonly cronJobTool: any,
    ) {
        const prompt = PromptTemplate.fromTemplate(
            '请回答以下问题：\n\n{query}',
        );
        this.chain = prompt.pipe(model).pipe(new StringOutputParser());

        this.modelWithTools = model.bindTools([
            this.sendMailTool,
            this.webSearchTool,
            this.dbUsersCrudTool,
            this.timeNowTool,
            this.cronJobTool,
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
                } else if (toolName === 'time_now') {
                    const result = await this.timeNowTool.invoke(toolCall.args);
                    messages.push(
                        new ToolMessage({
                            tool_call_id: toolCallId,
                            name: toolName,
                            content: result,
                        }),
                    );
                } else if (toolName === 'cron_job') {
                    const result = await this.cronJobTool.invoke(toolCall.args);
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
    async *runChainStream(query: string): AsyncIterable<string> {
        const messages: BaseMessage[] = [
            new SystemMessage(
                `你是一个通用任务助手，可以根据用户的目标规划步骤，并在需要时调用工具：\`query_user\` 查询或校验用户信息、\`send_mail\` 发送邮件、\`web_search\` 进行互联网搜索、\`db_users_crud\` 读写数据库 users 表、\`time_now\` 获取当前时间、\`cron_job\` 创建和管理定时/周期任务（\`list\`/\`add\`/\`toggle\`），从而实现提醒、定期任务、数据同步等各种自动化需求。

                定时任务类型选择规则（非常重要）：
                - 用户说“X分钟/小时/天后”“在某个时间点”“到点提醒”（一次性）=> 用 \`cron_job\` + \`type=at\`（执行一次后自动停用），\`at\`=当前时间+X 或解析出的时间点
                - 用户说“每X分钟/每小时/每天”“定期/循环/一直”（重复执行）=> 用 \`cron_job\` + \`type=every\`（每次执行），\`everyMs\`=X换算成毫秒
                - 用户给出 Cron 表达式或明确说“用 cron 表达式”（重复执行）=> 用 \`cron_job\` + \`type=cron\`

                在调用 \`cron_job.add\` 创建任务时，需要把用户原始自然语言拆成两部分：一部分是“什么时候执行”（用来决定 type/at/everyMs/cron），另一部分是“要做什么任务本身”。\`instruction\` 字段只能填“要做什么”的那部分文本（保持原语言和原话），不能再改写、翻译或总结。

                当用户请求“在未来某个时间点执行某个动作”（例如“1分钟后给我发一个笑话到邮箱”）时，本轮对话只需要使用 \`cron_job\` 设置/更新定时任务，不要在当前轮直接完成这个动作本身：不要直接调用 \`send_mail\` 给他发邮件，也不要在当前轮就真正“执行”指令，只需把要执行的动作写进 \`instruction\` 里，交给将来的定时任务去跑。

                注意：像“\`1分钟后提醒我喝水\`”，时间相关信息用于计算下一次执行时间，而 \`instruction\` 应该是“提醒我喝水”；本轮不需要立刻提醒。`,
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
                } else if (toolName === 'cron_job') {
                    const result = await this.cronJobTool.invoke(toolCall.args);
                    messages.push(
                        new ToolMessage({
                            tool_call_id: toolCallId,
                            name: toolName,
                            content: result,
                        }),
                    );
                } else if (toolName === 'time_now') {
                    const result = await this.timeNowTool.invoke(toolCall.args);
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
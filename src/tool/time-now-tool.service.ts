import { Injectable } from '@nestjs/common';
import { tool } from '@langchain/core/tools';
import z from 'zod';

@Injectable()
export class TimeNowToolService {
    readonly tool;

    constructor() {
        const timeNowArgsSchema = z.object({});

        this.tool = tool(
            async () => {
                const now = new Date();
                return `当前时间：${now.toISOString()} (UTC) / ${now.toLocaleString()}`;
            },
            {
                name: 'time_now',
                description: '获取当前时间。',
                schema: timeNowArgsSchema,
            },
        );
    }
}

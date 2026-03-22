import { Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LlmService {
    constructor(private readonly configService: ConfigService) { }

    getModel(): ChatOpenAI {
        return new ChatOpenAI({
            temperature: 0,
            modelName: this.configService.get('MODEL_NAME'),
            apiKey: this.configService.get('API_KEY'),
            configuration: {
                baseURL: this.configService.get('BASE_URL')
            },
        });
    }
}

import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { ChatOpenAI } from '@langchain/openai';
import { ConfigModule, ConfigService } from '@nestjs/config';
@Module({
  controllers: [AiController],
  providers: [
    AiService,
    {
      provide: 'CHAT_MODEL',
      useFactory: (configService: ConfigService) => {
        return new ChatOpenAI({
          temperature: 0,
          modelName: configService.get('MODEL_NAME') ,
          apiKey: configService.get('API_KEY'),
          configuration: {
            baseURL: configService.get('BASE_URL') 
          },
        });
      },
      inject: [ConfigService],
      
    }
  ],
})
export class AiModule { }

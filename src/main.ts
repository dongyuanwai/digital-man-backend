import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
  console.log(`当前服务地址：http://localhost:${process.env.PORT ?? 3000}`); 
}
bootstrap();

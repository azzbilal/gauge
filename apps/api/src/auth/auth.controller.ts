import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthUser, CurrentUser, Public } from './auth.decorators';
import { parseLoginDto, parseRegisterDto } from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Public: registers an author. With an admin's token, any role. */
  @Public()
  @Post('register')
  register(@Body() body: unknown, @CurrentUser() caller?: AuthUser) {
    return this.auth.register(parseRegisterDto(body), caller);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    return this.auth.login(parseLoginDto(body));
  }

  /** Who the token belongs to, as the database says now. */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}

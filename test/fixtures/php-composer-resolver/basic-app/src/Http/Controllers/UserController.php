<?php
namespace App\Http\Controllers;

use App\Models\User;

class UserController extends BaseController {
  public function show() {
    return new User();
  }
}

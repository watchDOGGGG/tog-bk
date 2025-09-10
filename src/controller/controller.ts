import { Request, Response } from "express";
import { gameService } from "../service/service";
import { Types } from "mongoose";

class Controller {
  private readonly service = gameService;

  public joinGame = async (req: Request, res: Response) => {
    try {
      const { username, platform } = req.body as unknown as {
        username: string;
        platform: string;
      };

      const response = await this.service.joinGame(username, platform);

      return res.status(201).json({
        message: "Joined",
        data: response,
      });
    } catch (error: any) {
      return res.status(500).json({
        message: "Error joining game",
        error: error.message,
      });
    }
  };

  public getAllUsers = async (req: Request, res: Response) => {
    try {
      const response = await this.service.getAllUsers();
      return res.status(200).json({
        message: "all users",
        data: response,
      });
    } catch (error: any) {
      return res.status(500).json({
        message: "Error joining game",
        error: error.message,
      });
    }
  };

  public buyToken = async (req: Request, res: Response) => {
    try {
      const { user_id, no_of_token } = req.body;
      const response = await this.service.buyToken(user_id, no_of_token);

      return res.status(200).json({
        message: "tokens purchased successfully",
        data: response,
      });
    } catch (error: any) {
      return res.status(500).json({
        message: "Error buying tokens",
        error: error.message,
      });
    }
  };

  public useToken = async (req: Request, res: Response) => {
    try {
      const { user_id, no_of_token } = req.body;
      const response = await this.service.useToken(user_id, no_of_token);

      return res.status(200).json({
        message: "tokens used successfully",
        data: response,
      });
    } catch (error: any) {
      return res.status(500).json({
        message: "Error using tokens",
        error: error.message,
      });
    }
  };

  public getTokenCount = async (req: Request, res: Response) => {
    try {
      const { user_id } = req.params;
      const response = await this.service.getTokenCount(
        new Types.ObjectId(user_id)
      );

      return res.status(200).json({
        message: "tokens count successfully",
        data: response,
      });
    } catch (error: any) {
      return res.status(500).json({
        message: "Error counting tokens",
        error: error.message,
      });
    }
  };
}

export const controller = new Controller();

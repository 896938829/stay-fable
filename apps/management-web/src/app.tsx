import { Alert, App as AntApp, Card, Typography } from "antd";

const { Title } = Typography;

export function App() {
  return (
    <AntApp>
      <main className="shell">
        <Card>
          <Title level={1}>Stay Fable 管理平台</Title>
          <Alert
            type="success"
            showIcon
            message="基础环境已就绪"
            description="商家和运营功能将在后续阶段按权限逐步开放。"
          />
        </Card>
      </main>
    </AntApp>
  );
}

import { useState, type FormEvent } from 'react';
import Button from '@arco-design/web-react/es/Button';
import Input from '@arco-design/web-react/es/Input';
import { IconEmail, IconLeft, IconLock } from '@arco-design/web-react/icon';

import '@/styles/arco-password-auth';

import { useLocale } from '@/i18n/localeContext';

type PasswordLoginFormProps = {
  loading: boolean;
  showBrowserLogin: boolean;
  onSubmit: (email: string, password: string) => void;
  onUseBrowser: () => void;
};

export function PasswordLoginForm({
  loading,
  showBrowserLogin,
  onSubmit,
  onUseBrowser,
}: PasswordLoginFormProps) {
  const { t } = useLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) return;
    onSubmit(normalizedEmail, password);
  };

  return (
    <form className="desktop-password-form" onSubmit={submit}>
      <label>
        <span>{t('auth.adminEmail')}</span>
        <Input
          size="large"
          prefix={<IconEmail />}
          placeholder={t('auth.adminEmailPlaceholder')}
          autoComplete="username"
          inputMode="email"
          value={email}
          onChange={setEmail}
        />
      </label>
      <label>
        <span>{t('auth.adminPassword')}</span>
        <Input.Password
          size="large"
          prefix={<IconLock />}
          placeholder={t('auth.adminPasswordPlaceholder')}
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
        />
      </label>
      <Button
        htmlType="submit"
        type="primary"
        size="large"
        loading={loading}
        disabled={!email.trim() || !password}
        long
      >
        {t('auth.adminSubmit')}
      </Button>
      {showBrowserLogin && (
        <Button type="text" icon={<IconLeft />} onClick={onUseBrowser}>
          {t('auth.useBrowser')}
        </Button>
      )}
    </form>
  );
}

# Kurye Fatura Paneli

Kuryelerin aylık paket sayılarını (Tekli/İlk, Çiftli/Birleşen, Finans, Çarşı, Yemek) ekran görüntüsünden okuyup
kişiye özel fiyatlarla hakedişi hesaplayan, yüzdelik giderleri uygulayan ve fatura özetini görsel olarak
WhatsApp'tan gönderen statik site. Sunucu yok; GitHub Pages'te çalışır.

## Kurulum (GitHub Pages)

1. GitHub'da yeni bir depo aç (örn. `kurye-fatura`), bu klasördeki dosyaları yükle.
2. Depo → **Settings → Pages** → Source: `Deploy from a branch`, Branch: `main` / `(root)` → Save.
3. Birkaç dakika sonra site `https://<kullanıcı>.github.io/kurye-fatura/` adresinde açılır.

## Giriş sistemi ve veri kaydı (Supabase)

Veriler Supabase'te saklanır; sadece izin verilen e-postalar giriş yapabilir.

1. supabase.com → projen (store-panel'in projesi de olur) → **SQL Editor** → `supabase.sql` dosyasının
   tamamını yapıştır. En alttaki `SENIN@EPOSTAN.com` yerine giriş e-postanı yaz → **Run**.
2. **Authentication → Users → Add user → Create new user**: aynı e-posta + şifre ("Auto Confirm User" işaretli).
3. **Project Settings → API**: `Project URL` ve `anon public` anahtarını `config.js` içine yaz.
4. Başka birine erişim vermek için: `insert into kurye_members (email) values ('kisi@ornek.com');` + kullanıcı oluştur.

## İlk ayarlar (Ayarlar sekmesi)

- **Kategoriler ve fiyatlar:** standart paket fiyatlarını gir. Kişiye özel fiyat Kişiler sekmesinden girilir.
- **Ekstra giderler:** ad + yüzde + “düş / ekle”. Brüt toplam üzerinden hesaplanır, kişiye göre oran değiştirilebilir.
- **Claude API anahtarı:** ekran görüntüsünü okumak için (console.anthropic.com → API Keys). Hesapta saklanır.

## Aylık kullanım

1. Üstten ayı seç.
2. **Ekran Görüntüsü** sekmesinde görüntüleri seç / sürükle / Ctrl+V ile yapıştır.
3. İsimler kişilerle otomatik eşleşir; eşleşmeyeni listeden seç ya da “Yeni kişi olarak ekle”. Kaydet.
4. **Dönem** sekmesinde her kişinin kesilecek fatura tutarı görünür. **WhatsApp** butonu:
   - Telefonda: paylaşım menüsü açılır → WhatsApp → kişiyi seç → gönder.
   - Bilgisayarda: görsel panoya kopyalanır, kişinin WhatsApp sohbeti açılır → Ctrl+V → gönder.
5. “Sırayla gönder” gönderilmemiş herkesi tek tek gezer.

## WhatsApp'tan tamamen otomatik gönderim hakkında

Bu site her gönderide senin bir kez “gönder”e basmanı ister. Tam otomatik (tek tıkla herkese) göndermek için
**WhatsApp Business Cloud API** gerekir: Meta Business hesabı, bu iş için ayrı bir telefon numarası,
Meta'nın onayladığı bir mesaj şablonu ve token'ı saklayacak küçük bir sunucu (örn. Supabase Edge Function).
Konuşma başına Meta ücreti alınır. Statik bir GitHub Pages sitesi bu token'ı güvenle tutamaz.

---
Created by **Voo Game Studio**

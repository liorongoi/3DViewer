HOLO server for Linux: read this first
=====================================

You do not need root, sudo or admin rights. Everything goes into one folder in your home folder
(~/holo). Type each line below into the terminal and press Enter.


1. Check this machine (optional, changes nothing)

     ./deploy/bin/holo-check

   It says whether HOLO can run here, and whether the graphics card can train Gaussian splats.
   Its output names no machine, address or user, so you can copy it and send it for support.


2. Install and start

     ./install-user.sh

   It checks the machine and the download, copies HOLO to ~/holo, and starts it. At the end it
   prints two things. Write them down:

     - the address to open, such as http://10.0.0.5:8080/
     - the admin password

   Open the address in Chrome or Edge on any computer on the same network, and sign in as admin.
   In the HOLO Windows app, the same address goes in as the server address.


3. Every day: the holo command

     holo status      is it running, and its address
     holo stop        stop it
     holo start       start it again
     holo check       what this machine can do
     holo logs        the last messages, if something is wrong
     holo report      a file to send for support (no addresses or names in it)
     holo backup      a backup now (one is also made every night at 02:30)
     holo help        all of them

   If the terminal says "holo: command not found", open a new terminal, or type ~/holo/holo
   instead of holo.


Good to know

  - It starts by itself after the machine restarts.
  - Your models are kept in ~/holo/data, and backups in ~/holo/backups. Uninstalling keeps them.
  - To update, unpack the new version and run ./install-user.sh in it. If the new version does
    not start, it goes back to the old one by itself.
  - Another port: ./install-user.sh --port 9000 (any number from 1024 to 65535).
  - Without a certificate, the address is http (not https). That is fine on a trusted network.
    With the organisation's certificate:
      ./install-user.sh --cert chain.pem --key key.pem --host holo.example
  - Other users of the machine cannot read your HOLO settings or data.

Something wrong? Run this, and send the file it names:

     holo report

   It holds the machine check and the recent messages, with every network address, host name and
   user name taken out.
